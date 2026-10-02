# Единственный актуальный checklist внешних входов

2026-10-02, Asia/Vladivostok. **NOT_READY / NO_GO**. Все пункты ниже открыты; примеры и локальные fixtures не являются квалификацией. Исторические списки в runbook’ах служат пояснениями контрактов; актуальный перечень для запуска — только этот файл. Значения credentials, tokens, private keys сюда не записывать. Для каждого пункта назначить owner, предоставить несекретную ссылку на evidence и записать qualification/approval decision.

- [ ] **A — Linux target:** SSH target/IP, deployment user/path, architecture/platform, timezone; persistent DB/storage paths/UID1001 и capacity; фактические 80/443/NAT/firewall/proxy, свободные172.29/172.30; native whole-directory TLS bind/reload и target systemd/reboot qualification. Отдельный внешний maintenance barrier/wrapper с drain uploads, TERM/timeout и fail-closed recovery.
- [ ] **B — Domain/CA:** FQDN, A/AAAA control, public reachability; ACME account/contact и HTTP-01 либо DNS-01 decision. Existing unattended helper поддерживает HTTP-01; DNS-01 требует отдельной квалификации. Public chain/SAN/expiry, issuance/renewal/recovery на реальном target.
- [ ] **C — Registry:** hostname/backend+frontend repositories, auth method и внешнее credential-helper/DOCKER_CONFIG location, TLS/CA trust, target platform; provider retention/immutability/GC policy и сохранность обеих release pairs; fresh target push/pull/digest/provenance evidence и доступность replacement host.
- [ ] **D — Alerts:** реальный HTTPS endpoint/channel, внешнее auth placement; human recipient, TEST receipt/acknowledgement, escalation owner/process; scheduler/barrier delivery на target и внешний watchdog при полном отказе host/network.
- [ ] **E — Offsite/custody:** реальный target/failure domain/transport/capacity; ACL, independent inventory, retention/delete separation/immutability evidence; named custodian roles, две независимые защищённые custody locations, минимум одна вне primary failure domain; emergency approval/access/audit, rotation и replacement-host key/config/image access без source.
- [ ] **F — Recovery policy:** owner-approved RPO/RTO, backup cadence/freshness/escalation, launch DB/storage volume и write rate, maintenance window; production-volume recovery drill с snapshot/data/bytes verification. Candidate12min относится только к128MiB локальному fixture с подготовленными images/tools, не является approved budget.
- [ ] **G — Final host/browser/operator acceptance:** реальный public endpoint desktop+narrow browser/session/upload/share/trash/TLS/CSP acceptance; назначенный оператор выполняет deploy/full-pair rollback/recovery без chat context, фиксирует STOP handling и ≥15min observation readiness/errors/latency/disk. Отдельное owner GO после закрытия всех blockers.

Для read-only aggregator оператор создаёт внешний0700 каталог и0600 `qualification.json` с ровно двумя objects `external` и `approvals`. Каждый перечисленный ключ имеет `{ "qualified": false, "record": "" }` до квалификации. После квалификации: `true` и абсолютный path непустого несекретного record; helper проверяет наличие, не правдивость record.

`external` keys: `linux_target`, `dns_public_ca`, `registry`, `alert_recipient`, `offsite`, `custody`, `host_browser_operator_acceptance`, `external_watchdog`, `maintenance_barrier`, `production_volume_recovery`.

`approvals` keys: `rpo`, `rto`, `backup_cadence`, `launch_dataset`, `maintenance_window`.

Recovery identity не помещается в writer/scheduler env. Custody record фиксирует процедуру получения identity для отдельного recovery env; bytes и credentials остаются вне checklist/Git/chat.
