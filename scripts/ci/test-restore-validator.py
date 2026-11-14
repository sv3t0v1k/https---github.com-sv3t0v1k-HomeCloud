#!/usr/bin/env python3
"""Execute the actual isolated validator JS with privilege/process sentinels."""
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / "scripts/restore.sh").read_text()
CODE = SOURCE.split('const fs=require("fs"), path=require("path"), readline=require("readline"), cp=require("child_process");', 1)[1]
CODE = 'const fs=require("fs"), path=require("path"), readline=require("readline"), cp=require("child_process");' + CODE.split("' >/dev/null; then", 1)[0]


class ValidatorTests(unittest.TestCase):
    def invoke(self, status=0, unsafe=False):
        harness = r'''
const vm = require("node:vm"), path = require("node:path");
const input = JSON.parse(process.argv[1]), calls = [], callbacks = {};
const tree = {"/storage":[".tmp","1"],"/storage/.tmp":[],"/storage/1":["source.bin"]};
const proc = {env:{STORAGE_PATH:"/storage"}, stdin:{}, execPath:"/usr/bin/node",
 setgroups:v=>calls.push(["groups",v]), setgid:v=>calls.push(["gid",v]),
 setuid:v=>calls.push(["uid",v]), exit:v=>calls.push(["exit",v])};
const fake = {
 chmodSync(){}, mkdirSync(){},
 lstatSync:name=>({isFile:()=>!tree[name],isDirectory:()=>!!tree[name]}),
 readdirSync:name=>tree[name], chownSync:(...args)=>calls.push(["chown",...args]),
};
try {
 vm.runInNewContext(input.code, {require:name=>{
  if(name==="fs") return fake;
  if(name==="path") return path;
  if(name==="readline") return {createInterface:()=>({on:(name,cb)=>callbacks[name]=cb})};
  if(name==="child_process") return {spawnSync:(...args)=>{calls.push(["spawn",...args]);return {status:input.status};}};
  throw Error("unexpected import");
 }, process:proc});
 if(input.unsafe) callbacks.line(JSON.stringify({name:"../outside",size:1}));
 callbacks.close();
 console.log(JSON.stringify({calls}));
} catch(error) { console.log(JSON.stringify({calls,error:error.message})); }
'''
        return json.loads(subprocess.check_output(
            ["node", "-e", harness, json.dumps({"code": CODE, "status": status, "unsafe": unsafe})],
            text=True,
        ))

    def test_isolated_migrations_use_nonroot_native_supervisor(self):
        result = self.invoke()
        self.assertNotIn("error", result)
        calls = result["calls"]
        spawn = next(i for i, call in enumerate(calls) if call[0] == "spawn")
        self.assertEqual(calls[spawn-3:spawn], [["groups", []], ["gid", 65533], ["uid", 1001]])
        self.assertEqual(calls[spawn][2], [
            "docker/copy-root-fence-supervisor.cjs", "--operator-cli", "node",
            "./node_modules/typeorm/cli.js", "migration:run", "-d", "dist/data-source.js", "--transaction", "all",
        ])
        self.assertEqual(calls[-1], ["exit", 0])

    def test_supervisor_failure_propagates(self):
        self.assertEqual(self.invoke(status=42)["calls"][-1], ["exit", 42])
        self.assertEqual(self.invoke(status=None)["calls"][-1], ["exit", 1])

    def test_invalid_sparse_path_never_starts_migration(self):
        result = self.invoke(unsafe=True)
        self.assertIn("Unsafe sparse archive path", result["error"])
        self.assertFalse(any(call[0] == "spawn" for call in result["calls"]))


if __name__ == "__main__":
    unittest.main()
