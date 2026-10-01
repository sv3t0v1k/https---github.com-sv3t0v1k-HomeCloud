#!/usr/bin/env python3
"""Static verify by default. Install only on operator-selected Linux host."""
import argparse
from pathlib import Path
import shutil
import subprocess
import sys
p=argparse.ArgumentParser()
p.add_argument('--install',action='store_true')
a=p.parse_args()
root=Path(__file__).resolve().parents[1]
units=sorted((root/'ops/systemd').glob('homecloud-*.*'))
subprocess.run(['systemd-analyze','verify',*[str(x) for x in units]],check=True)
if a.install:
    if root != Path('/opt/homecloud'): sys.exit('Install checkout at /opt/homecloud first')
    if not Path('/etc/homecloud/scheduler.json').is_file(): sys.exit('External scheduler config required')
    subprocess.run(['/usr/bin/python3',str(root/'scripts/scheduled-operations.py'),'/etc/homecloud/scheduler.json','--validate'],check=True)
    for x in units: shutil.copyfile(x,Path('/etc/systemd/system')/x.name)
    subprocess.run(['systemctl','daemon-reload'],check=True)
    subprocess.run(['systemctl','enable','--now',*[x.name for x in units if x.suffix=='.timer']],check=True)
