#!/usr/bin/env python3
"""Discover an untrusted current TEST identity hint for a disposable CI drill.

This is CI orchestration, not a qualified host helper or installation entry.
The root step must independently re-fetch using its pinned update_source.
"""


def fetch_current(modules, client):
    source = modules['update_source']
    contract = modules['test_contract']
    branch = client.api_json('/branches/test')
    source.require(type(branch) is dict and branch.get('protected') is True
                   and type(branch.get('commit')) is dict,
                   'Invalid protected TEST branch')
    head = branch['commit'].get('sha')
    source.require(type(head) is str and source.SHA.fullmatch(head),
                   'Invalid TEST HEAD')

    runs = client.api_json(
        f'/actions/runs?branch=test&event=push&head_sha={head}&per_page=10')
    source.require(type(runs) is dict and type(runs.get('workflow_runs')) is list,
                   'Invalid TEST run inventory')
    selected = [item for item in runs['workflow_runs']
                if type(item) is dict and item.get('head_sha') == head
                and item.get('head_branch') == 'test' and item.get('event') == 'push'
                and item.get('path') == '.github/workflows/ci-v2-fast.yml'
                and item.get('status') == 'completed'
                and item.get('conclusion') == 'success'
                and type(item.get('id')) is int and item['id'] > 0
                and type(item.get('run_attempt')) is int
                and item['run_attempt'] > 0]
    source.require(len(selected) == 1, 'Ambiguous or missing successful TEST run')
    run = selected[0]

    inventory = client.api_json(f"/actions/runs/{run['id']}/artifacts?per_page=100")
    source.require(type(inventory) is dict and type(inventory.get('artifacts')) is list,
                   'Invalid TEST artifact inventory')
    artifacts = [item for item in inventory['artifacts']
                 if type(item) is dict
                 and item.get('name') == f"test-channel-{run['run_attempt']}"
                 and item.get('expired') is False
                 and type(item.get('workflow_run')) is dict
                 and item['workflow_run'].get('id') == run['id']
                 and item['workflow_run'].get('head_sha') == head
                 and type(item.get('id')) is int and item['id'] > 0]
    source.require(len(artifacts) == 1, 'Ambiguous or missing TEST artifact')
    artifact = artifacts[0]
    manifest = client.artifact_json(artifact['id'])
    source.require(type(manifest) is dict, 'Invalid TEST manifest')
    validated = modules['update_evidence'].verify(
        manifest.get('manifest_sha256'), branch, run, artifact, manifest,
        contract.shape)
    # Re-read the protected branch, run, artifact and ZIP; fetch_test_evidence
    # also rejects a branch move during that second verification window.
    return source.fetch_test_evidence(validated['manifest_sha256'], contract.shape,
                                      client)


def main():
    import importlib.util
    import os
    from pathlib import Path
    import sys

    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / 'deploy/linux'))
    sys.path.insert(0, str(root / 'scripts/ci'))
    import update_evidence
    import update_source

    spec = importlib.util.spec_from_file_location(
        'test_contract', root / 'scripts/ci/test-channel.py')
    contract = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(contract)
    modules = {'update_source': update_source,
               'update_evidence': update_evidence, 'test_contract': contract}
    manifest = fetch_current(modules, update_source.GitHubClient(
        os.environ.get('GH_TOKEN', '')))
    print(manifest['manifest_sha256'])


if __name__ == '__main__':
    main()
