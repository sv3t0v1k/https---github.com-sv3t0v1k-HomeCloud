import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile

HERE=Path(__file__).resolve().parent
REPO=Path('/Users/aleksejkozemakin/Desktop/HomeCloud')
R1=REPO/'docs/evidence/secure-filesystem-adapter-implementation-r1-20261011'
R1Q=REPO/'docs/evidence/secure-filesystem-adapter-native-amd64-r1q-20261011'
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip()=='37190a8d3e77cc80314790df71d74e0ac121e143'
for name in ('adversarial.cjs','recovery.cjs'):
    content=(R1/name).read_text().replace('assert.equal(process.getuid(),1001)', 'assert.equal(process.getuid(),1000)')
    content=content.replace('Docker Desktop/LinuxKit; disposable tmpfs', 'native Linux AMD64; disposable persistent ext4')
    content=content.replace('isolated schema/tmpfs', 'isolated schema/persistent ext4')
    (HERE/name).write_text(content)
(HERE/'artifact-probe.cjs').write_bytes((R1Q/'artifact-probe.cjs').read_bytes())
probe=(R1Q/'syscall-probe.c').read_text().replace('if(getuid()!=1001)', 'if(getuid()!=1000 && getuid()!=1001)').replace('Require uid1001', 'Require non-root uid1000 or1001')
probe=probe.replace('open("/qualified",', 'open(getenv("HC_PROBE_ROOT") ? getenv("HC_PROBE_ROOT") : "/qualified",')
(HERE/'syscall-probe.c').write_text(probe)
tracked=subprocess.check_output(['git','ls-files','-z','--','backend'],cwd=REPO).decode().strip('\0').split('\0')
manifest={}
with tarfile.open(HERE/'qualification-bundle.tar.gz','w:gz') as archive:
    for name in tracked:
        p=Path(name)
        if any(x.startswith('.env') or x in ('secrets','certs','.npmrc') for x in p.parts) or p.suffix in ('.pem','.key','.p12','.pfx'):
            continue
        file=REPO/name
        assert file.is_file() and not file.is_symlink(),name
        data=file.read_bytes();manifest[name]=hashlib.sha256(data).hexdigest()
        archive.add(file,arcname='source/'+name,recursive=False)
    for name in ('adversarial.cjs','recovery.cjs','artifact-probe.cjs','syscall-probe.c'):
        archive.add(HERE/name,arcname='probes/'+name)
    archive.add(HERE/'compose.yaml',arcname='compose.yaml')
(HERE/'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Tracked backend-only files',len(manifest),'archive bytes',(HERE/'qualification-bundle.tar.gz').stat().st_size)
