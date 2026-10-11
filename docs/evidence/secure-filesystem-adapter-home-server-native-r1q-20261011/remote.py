"""Narrow local SSH runner: capture output, never credentials or remote environment."""
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
args = ["ssh", "-o", "BatchMode=yes", "-o", "NumberOfPasswordPrompts=0", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8", "hs@192.168.3.44"]
command = sys.argv[1]
output = HERE / sys.argv[2]
with output.open("w") as log:
    result = subprocess.run(args + [command], stdout=log, stderr=subprocess.STDOUT)
print("remote exit=" + str(result.returncode) + " log=" + str(output))
raise SystemExit(result.returncode)
