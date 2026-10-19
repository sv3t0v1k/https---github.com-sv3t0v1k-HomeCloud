#!/usr/bin/env python3
"""Pair offline OCI proofs into a non-release manifest, without Git tag/registry writes."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import release


def pair(backend, frontend, commit, repository, run_id, attempt, version='dry-run'):
    release.require(bool(provenance_version(version)), 'invalid candidate version')
    release.require(re.fullmatch(r'[a-f0-9]{40}', commit), 'full source commit required')
    release.require(release.REPO.fullmatch(repository), 'invalid repository')
    release.require(run_id.isdigit() and attempt.isdigit(), 'invalid run identity')
    release.require(release.git('rev-parse', 'HEAD') == commit, 'checkout/source mismatch')
    release.require(not release.git('diff', '--name-only', 'HEAD', '--', '.', release.EXCLUDED), 'dirty tracked source')
    images = {}
    for role, proof in (('backend', backend), ('frontend', frontend)):
        release.require(proof['format'] == 'homecloud-provenance-dry-run-v1' and proof['status'] == 'OFFLINE_OCI_VERIFIED', 'offline proof required')
        release.require(proof['commit'] == commit and proof['repository'] == 'ghcr.io/'+repository+'/'+role, 'proof/source mismatch')
        release.require(proof['platform'] == 'linux/amd64' and proof['version'] == version, 'proof/platform/version mismatch')
        release.require(proof['verified'] == 'DIGEST_SUBJECT_VCS_DOCKERFILE_ARGS_BASE_MATERIALS' and proof['signature'] == 'UNSIGNED', 'incomplete proof')
        release.require(proof['ghcr_state'] == 'NOT_PUBLISHED_NOT_TESTED', 'dry-run must not imply publication')
        for key in ('index_digest', 'platform_digest', 'statement_digest'):
            release.require(release.DIGEST.fullmatch(proof[key]), 'invalid proof digest')
        images[role] = proof
    files = [release.ROOT/path for path in release.SOURCE_PATHS]
    files += sorted((release.ROOT/'backend/src/migrations').glob('*.ts'))
    # Hash the hypothetical annotated object's exact bytes without creating any Git object or ref.
    tag_bytes = ('object '+commit+'\ntype commit\ntag v0.0.0-beta.1\n'
                 'tagger Проверка <fixture@example.invalid> 0 +0000\n\n'
                 'Непубликуемая проверка цепочки релиза\n').encode()
    synthetic_object = hashlib.sha1(('tag '+str(len(tag_bytes))+'\0').encode()+tag_bytes).hexdigest()
    result = dict(format='homecloud-release-dry-run-v1', commit=commit, repository=repository, candidate_version=version,
                  synthetic_tag='v0.0.0-beta.1', synthetic_tag_object=synthetic_object,
                  tag_state='IN_MEMORY_ONLY_NO_OBJECT_OR_REF_CREATED', images=images,
                  source_files={str(path.relative_to(release.ROOT)):release.file_hash(path) for path in files},
                  base_images=json.loads((release.ROOT/'scripts/ci/images.lock.json').read_text()),
                  ci=dict(run_id=run_id,attempt=attempt),
                  ghcr_state='NOT_PUBLISHED_NOT_TESTED', release_state='NOT_CREATED',
                  deployment_status='NOT_DEPLOYED', production='NO_GO',
                  limitation='Unsigned local OCI proof exercises verification logic; remote GHCR availability/digest reconciliation and an approved release tag are not tested.')
    result['manifest_sha256'] = release.identity(result)
    return result


def provenance_version(version):
    return version == 'dry-run' or release.TAG.fullmatch(version)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('backend','frontend','commit','repository','run-id','attempt','output'):
        parser.add_argument('--'+name,required=True)
    parser.add_argument('--version', default='dry-run')
    args = parser.parse_args()
    try:
        result = pair(json.loads(Path(args.backend).read_text()),json.loads(Path(args.frontend).read_text()),
                      args.commit,args.repository,args.run_id,args.attempt,args.version)
        Path(args.output).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
        print('PASS: non-release pair manifest; Git tag, GHCR and release NOT_RUN')
    except (ValueError,KeyError,OSError) as error:
        raise SystemExit('BLOCKED: '+str(error))
