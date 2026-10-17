import hashlib, importlib.util, json, pathlib, sys, yaml
root=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(root/'ops/postgres'))
import prepare
class Loader(yaml.SafeLoader): pass
def override(loader,node):
    if isinstance(node,yaml.SequenceNode):return loader.construct_sequence(node,deep=True)
    if isinstance(node,yaml.MappingNode):return loader.construct_mapping(node,deep=True)
    raise ValueError('unexpected override type')
Loader.add_constructor('!override',override)
base=yaml.load((root/'docker-compose.yml').read_text(),Loader=Loader)
prod=yaml.load((root/'docker-compose.production.yml').read_text(),Loader=Loader)
lock=prepare.load_lock()
import argparse
parser=argparse.ArgumentParser(description='Статический контракт Compose и exact OCI; без Docker/интерполяции env')
parser.add_argument('--archive',required=True,type=pathlib.Path)
args=parser.parse_args()
archive=args.archive
prepare.verify_evidence(lock)
prepare.verify_archive(archive,lock)
_,manifest,config=prepare.binding_module().identity(archive)
runtime=config['config']; env=dict(x.split('=',1) for x in runtime['Env'])
db=base['services']['db']; pdb=prod['services']['db']; merged=dict(db);merged.update(pdb)
prepare.require(config['os']=='linux' and config['architecture']=='amd64', "Compose contract mismatch: config['os']=='linux' and config['architecture']=='amd64'")
prepare.require(runtime['Entrypoint']==['docker-entrypoint.sh'] and runtime['Cmd']==['postgres'], "Compose contract mismatch: runtime['Entrypoint']==['docker-entrypoint.sh'] and runtime['Cmd']==['postgres']")
prepare.require(runtime.get('User','') in ('','0','root'), "Compose contract mismatch: runtime.get('User','') in ('','0','root')")
prepare.require(env['PGDATA']=='/var/lib/postgresql/data' and env['PG_VERSION']=='16.15', "Compose contract mismatch: env['PGDATA']=='/var/lib/postgresql/data' and env['PG_VERSION']=='16.15'")
prepare.require('/var/lib/postgresql/data' in runtime['Volumes'], "Compose contract mismatch: '/var/lib/postgresql/data' in runtime['Volumes']")
prepare.require(pdb['image']==lock['base'] and pdb['platform']=='linux/amd64', "Compose contract mismatch: pdb['image']==lock['base'] and pdb['platform']=='linux/amd64'")
prepare.require(pdb['entrypoint']==['sh','/run/homecloud/startup-gate.sh','db'] and pdb['command']==['postgres'], "Compose contract mismatch: pdb['entrypoint']==['sh','/run/homecloud/startup-gate.sh','db'] and pdb['command']==['postgres']")
prepare.require('exec /usr/local/bin/docker-entrypoint.sh "$@"' in (root/'deploy/linux/startup-gate.sh').read_text(), 'Compose contract mismatch: \'exec /usr/local/bin/docker-entrypoint.sh "$@"\' in (root/\'deploy/linux/startup-gate.sh\').read_text()')
prepare.require('ports' not in db and 'ports' not in pdb, "Compose contract mismatch: 'ports' not in db and 'ports' not in pdb")
prepare.require(db['volumes']==['db_data:/var/lib/postgresql/data'], "Compose contract mismatch: db['volumes']==['db_data:/var/lib/postgresql/data']")
prepare.require(pdb['volumes'][0]['source'].startswith('${SSD_DB_DIR:?'), "Compose contract mismatch: pdb['volumes'][0]['source'].startswith('${SSD_DB_DIR:?')")
prepare.require(pdb['volumes'][0]['target']==env['PGDATA'] and pdb['volumes'][0]['bind']['create_host_path'] is False, "Compose contract mismatch: pdb['volumes'][0]['target']==env['PGDATA'] and pdb['volumes'][0]['bind']['create_host_path'] is False")
prepare.require(merged['environment']==db['environment'], "Compose contract mismatch: merged['environment']==db['environment']")
prepare.require(merged['healthcheck']==db['healthcheck'] and merged['mem_limit']=='1g', "Compose contract mismatch: merged['healthcheck']==db['healthcheck'] and merged['mem_limit']=='1g'")
prepare.require('$${POSTGRES_USER}' in db['healthcheck']['test'][1] and '$${POSTGRES_DB}' in db['healthcheck']['test'][1], "Compose contract mismatch: '$${POSTGRES_USER}' in db['healthcheck']['test'][1] and '$${POSTGRES_DB}' in db['healthcheck']['test'][1]")
prepare.require(db['networks']==['app_network'] and db['logging']['options']=={'max-size':'10m','max-file':'3'}, "Compose contract mismatch: db['networks']==['app_network'] and db['logging']['options']=={'max-size':'10m','max-file':'3'}")
result={'status':'PASS_STATIC_CONTRACT_ONLY','candidate_manifest':lock['manifest'],
 'exact_config_checked':manifest['config']['digest'], 'yaml_parser':'PyYAML '+yaml.__version__,
 'production_base_unchanged':True,'entrypoint_chain':'startup-gate.sh db -> /usr/local/bin/docker-entrypoint.sh postgres',
 'PGDATA':env['PGDATA'],'PG_VERSION':env['PG_VERSION'],'root_entrypoint_preserved':True,
 'production_storage':'existing SSD bind; create_host_path=false; unchanged gate/marker mounts',
 'mac_storage':'named db_data; not interchangeable with production SSD bind',
 'db_healthcheck_env_mem_network_logging_preserved':True,'db_published_ports':False,
 'compose_cli_merge_interpolation':'NOT_RUN','startup_gate_in_candidate_runtime':'NOT_RUN',
 'direct_candidate_to_official_rollback':'NOT_RUN','production':'NO_GO',
 'input_sha256':{str(p):hashlib.sha256((root/p).read_bytes()).hexdigest() for p in
 ['docker-compose.yml','docker-compose.production.yml','deploy/linux/startup-gate.sh','scripts/ci/production-images.lock.json']}}
print(json.dumps(result,ensure_ascii=False,indent=2))
