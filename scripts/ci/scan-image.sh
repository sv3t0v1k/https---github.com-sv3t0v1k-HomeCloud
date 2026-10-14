#!/bin/sh
set -eu
scanner=${1:?Specify checksum-verified Trivy binary}
source_kind=${2:?Specify remote or docker}
reference=${3:?Specify immutable base reference or disposable local image}
report=${4:?Specify JSON report destination}
case "$source_kind" in remote|docker) ;; *) exit 1 ;; esac
# Include all severities and both OS/language packages in the retained report.
# No ignore-unfixed, ignore file, policy exceptions, secret scan, or daemon mutation.
"$scanner" image --image-src "$source_kind" --platform linux/amd64 \
  --scanners vuln --ignore-unfixed=false --ignorefile /dev/null --timeout 15m --no-progress \
  --format json --output "$report" "$reference"
python3 - "$report" <<'PY'
import collections, json, sys
report = json.load(open(sys.argv[1]))
assert report.get('ArtifactType') == 'container_image', 'Expected container image report'
image_config = report.get('Metadata', {}).get('ImageConfig', {})
assert (image_config.get('os'), image_config.get('architecture')) == ('linux', 'amd64'), 'Expected scanned linux/amd64 image'
assert isinstance(report.get('Results'), list) and report['Results'], 'Missing scan results'
assert any(result.get('Class') == 'os-pkgs' for result in report['Results']), 'Missing OS package vulnerability scan'
assert all(isinstance(result.get('Vulnerabilities', []), list) for result in report['Results']), 'Invalid vulnerability result'
findings = [v for result in report['Results'] for v in result.get('Vulnerabilities', [])]
counts = collections.Counter(v['Severity'] for v in findings)
assert all(v.get('VulnerabilityID') and v.get('PkgName') and v.get('Severity') in ('UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL') for v in findings), 'Invalid finding'
print(json.dumps({'artifact': report['ArtifactName'], 'findings': dict(sorted(counts.items())), 'gate': 'BLOCKED' if counts['HIGH'] or counts['CRITICAL'] else 'PASS'}, sort_keys=True))
assert not (counts['HIGH'] or counts['CRITICAL']), 'Image contains high/critical vulnerabilities; report retained'
PY
