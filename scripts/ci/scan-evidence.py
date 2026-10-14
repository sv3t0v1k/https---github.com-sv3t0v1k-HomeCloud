#!/usr/bin/env python3
"""Retain DB/target evidence and reject stale or mismatched image scans."""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import sys


def timestamp(value):
    # Trivy emits RFC3339 nanoseconds; Python 3.9 accepts up to microseconds.
    value = re.sub(r'(\.\d{6})\d+(?=Z$|[+-]\d{2}:\d{2}$)', r'\1', value)
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('DB timestamps must include timezone')
    return result


def validate(report, metadata, reference, now):
    if metadata.get('Version') != 2:
        raise ValueError('Expected vulnerability DB schema 2')
    updated, downloaded, next_update = (timestamp(metadata[k]) for k in
                                       ('UpdatedAt', 'DownloadedAt', 'NextUpdate'))
    tolerance = timedelta(minutes=5)
    if not (now - timedelta(hours=24) <= updated <= now + tolerance):
        raise ValueError('Vulnerability DB must be updated within 24 hours')
    if not (updated - tolerance <= downloaded <= now + tolerance):
        raise ValueError('Invalid vulnerability DB download time')
    if next_update <= now or next_update <= updated:
        raise ValueError('Vulnerability DB update is overdue')
    if report.get('ArtifactName') != reference:
        raise ValueError('Scan report does not match requested target')
    config = report.get('Metadata', {}).get('ImageConfig', {})
    if (config.get('os'), config.get('architecture')) != ('linux', 'amd64'):
        raise ValueError('Expected scanned linux/amd64 image')
    if report.get('Trivy', {}).get('Version') != '0.75.0':
        raise ValueError('Unexpected scanner version')


def main():
    report_path, metadata_path, source_kind, reference = sys.argv[1:]
    now = datetime.now(timezone.utc)
    evidence = dict(format='homecloud-image-scan-evidence-v1', observed_at=now.isoformat(),
                    source_kind=source_kind, requested_reference=reference,
                    platform='linux/amd64', maximum_db_age_hours=24,
                    java_db='not_required_no_java_targets', evidence_status='BLOCKED')
    try:
        report = json.loads(Path(report_path).read_text())
        metadata = json.loads(Path(metadata_path).read_text())
        evidence.update(vulnerability_db=metadata, scanner=report.get('Trivy'),
                        artifact_name=report.get('ArtifactName'),
                        image_id=report.get('Metadata', {}).get('ImageID'),
                        repo_digests=report.get('Metadata', {}).get('RepoDigests', []))
        validate(report, metadata, reference, now)
        if any(r.get('Type') == 'jar' for r in report.get('Results', [])):
            raise ValueError('Java target requires separate Java DB qualification')
        evidence['evidence_status'] = 'PASS'
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        evidence['error'] = str(error)
        raise
    finally:
        Path(report_path).with_suffix('.evidence.json').write_text(
            json.dumps(evidence, indent=2, sort_keys=True) + '\n')


if __name__ == '__main__':
    main()
