# D5.1.6 — стабилизация security CI

Production NO_GO сохраняется. Исключения CVE и изменения release policy не вводятся.

- Физический Node inventory требует `node-pkg`, а не результата по npm lockfile.
- Component scan направлен на установленный `node_modules`; проверяются реальные имена, версии и пути scoped/nested/alias packages.
- Rootfs identity учитывает фактический `/etc/hostname` Trivy; установленные OS/global npm packages остаются обязательными.
- Полный rootfs scope и анализаторы сохранены. Используются CPU parallelism, лимит 45 минут и достаточные job budgets; результат производительности подтверждается только итоговым CI.
- Все 16 окружений требуют отдельный tools scan: основной Trivy и дополнительные реально выполнявшиеся Trivy, Compose, Gitleaks. Версии, исходные/сканированные SHA256 и пути фиксируются; отсутствие inventory блокирует gate.
- Raw Gitleaks findings сохраняются без изменения правила или history. Только точный контекст двух исторических JSON evidence, координаты совпадения и независимая проверка соответствующего Git object позволяют классифицировать публичную ссылку.
- Локальная проверка исходных 122 findings: 119 подтверждены, 3 upstream references недоступны для подтверждения. Непроверенные findings остаются BLOCKED. Raw и индивидуальные proof records хранятся в CI artifacts; в новые tracked evidence они не копируются.
- Synthetic physical package fixture прошёл native Trivy 0.75; реальный Mac rootfs/Docker не использовался. Mach-O fixture непригоден для Linux gobinary; ELF fixture выявил необходимость сохранять executable mode копируемых инструментов. Итоговая квалификация Linux tools определяется единственным CI.

Порядок: целевые adversarial tests и workflow validation → один итоговый PR CI → независимый review фактических artifacts.
Полное покрытие означает 16/16 валидных environment evidence, а не просто наличие 16 artifacts. High/critical в обязательных production/build/CI проверках продолжают блокировать выпуск.
Зависимости приложения, базовые образы, GitHub rules и данные не менялись. Merge, release, публикация и deployment не выполняются.
