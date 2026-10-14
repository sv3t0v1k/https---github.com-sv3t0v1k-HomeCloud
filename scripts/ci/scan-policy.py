#!/usr/bin/env python3
"""Validate complete Trivy reports and apply severity policy without suppression."""
import argparse
from collections import Counter
import json
from pathlib import Path
import sys


def validate(report):
    if not isinstance(report, dict) or report.get('ArtifactType') != 'container_image':
        raise ValueError('Expected container image report')
    if not isinstance(report.get('ArtifactName'), str) or not report['ArtifactName']:
        raise ValueError('Missing artifact name')
    config = report.get('Metadata', {}).get('ImageConfig', {})
    if (config.get('os'), config.get('architecture')) != ('linux', 'amd64'):
        raise ValueError('Expected scanned linux/amd64 image')
    return validate_results(report)


def validate_results(report, require_os=True):
    """Shared completeness/findings checks; identity is qualified by each caller."""
    if not isinstance(report, dict):
        raise ValueError('Expected scan report object')
    results = report.get('Results')
    if not isinstance(results, list) or not results:
        raise ValueError('Missing scan results')
    if not all(isinstance(result, dict) for result in results):
        raise ValueError('Invalid scan result')
    if require_os:
        os_results = [result for result in results if result.get('Class') == 'os-pkgs']
        if not os_results:
            raise ValueError('Missing OS package vulnerability scan')
        for result in os_results:
            packages = result.get('Packages')
            if (not isinstance(packages, list) or not packages
                    or any(not isinstance(package, dict)
                           or not isinstance(package.get('Name'), str) or not package['Name']
                           or not isinstance(package.get('Version'), str) or not package['Version']
                           for package in packages)):
                raise ValueError('Missing or invalid OS package inventory')
    findings = []
    for result in results:
        vulnerabilities = result.get('Vulnerabilities', [])
        if not isinstance(vulnerabilities, list):
            raise ValueError('Invalid vulnerability result')
        for finding in vulnerabilities:
            if (not isinstance(finding, dict)
                    or not isinstance(finding.get('VulnerabilityID'), str)
                    or not finding['VulnerabilityID']
                    or not isinstance(finding.get('PkgName'), str)
                    or not finding['PkgName']
                    or finding.get('Severity') not in ('UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')):
                raise ValueError('Invalid finding')
            findings.append(finding)
    return findings


def evaluate(report, diagnostic=False):
    counts = Counter(finding['Severity'] for finding in validate(report))
    blocked = bool(counts['HIGH'] or counts['CRITICAL'])
    return dict(artifact=report['ArtifactName'], findings=dict(sorted(counts.items())),
                gate='DIAGNOSTIC' if diagnostic else ('BLOCKED' if blocked else 'PASS'),
                high_critical_present=blocked)


def evaluate_environment(report, component=False):
    if not isinstance(report, dict) or report.get('ArtifactType') not in ('filesystem', 'rootfs'):
        raise ValueError('Expected filesystem or rootfs report')
    findings = validate_results(report, require_os=not component)
    if component and not any(result.get('Class') == 'lang-pkgs'
                             and isinstance(result.get('Packages'), list) and result['Packages']
                             for result in report['Results']):
        raise ValueError('Missing component language package inventory')
    counts = Counter(finding['Severity'] for finding in findings)
    blocked = bool(counts['HIGH'] or counts['CRITICAL'])
    return dict(artifact=report.get('ArtifactName'), findings=dict(sorted(counts.items())),
                gate='BLOCKED' if blocked else 'PASS', high_critical_present=blocked)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report')
    parser.add_argument('--diagnostic', action='store_true',
                        help='Retain severity findings without a release verdict; raw bases only')
    parser.add_argument('--environment', action='store_true',
                        help='Qualify rootfs severity; separate environment evidence is required')
    parser.add_argument('--component', action='store_true',
                        help='Qualify component severity with retained language package inventory')
    args = parser.parse_args()
    try:
        report = json.loads(Path(args.report).read_text())
        if (args.environment or args.component) and args.diagnostic:
            raise ValueError('Environment checks cannot be diagnostic')
        if args.environment and args.component:
            raise ValueError('Select one environment report kind')
        summary = (evaluate_environment(report, component=args.component)
                   if args.environment or args.component else evaluate(report, args.diagnostic))
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        print(json.dumps(dict(gate='INVALID', error=str(error)), sort_keys=True))
        return 2
    print(json.dumps(summary, sort_keys=True))
    return 1 if summary['gate'] == 'BLOCKED' else 0


if __name__ == '__main__':
    sys.exit(main())
