# Реальные файлы в браузерах

| Имя | Байты | MIME сервера | Хранение и SHA-256 |
|---|---:|---|---|
| `ux-unknown.weird_ext` | 589 | `application/octet-stream` | PASS, `e22e4fe9c0f3dc8399a3055dc6efe0cf01dbd29c9b667d18739c375f80893acb` |
| `ux-small.BIN` | 262144 | `application/octet-stream` | PASS, `2312394bd99545d9de131c24efb781e765ac1aec243f2ed9347597a793a415e9` |
| `ux-no-extension` | 272 | `application/octet-stream` | PASS, `3913400cb181a09094a516f642da2a0e50d5ec8d5884e21361994a599587b8e0` |
| `ux-misleading.jpg` | 529 | `application/octet-stream` | PASS, `0e35b82633293ebd671c19b4e92df035464cad2f788ac5cdf025e6369956a461` |
| `ux-archive.7z` | 2054 | `application/x-7z-compressed` | PASS, `33013eb31bd1900b39f42e4f9efc4cde5a9f6b0e4c738b46050574679741fa70` |
| `ux-small.txt` | 56 | `text/plain` | PASS, `aedd74c2b9b7d99190bd4044d179fb124dc7f3de45b154cd67da58d6d49f54d8` |
| `ux-image.png` | 68 | `image/png` | PASS, `1cd75c6f6c3cb924286f8871dbbd8e3d037274a86a174c6d90a5ad104968ff3c` |
| `ux-Артефакт.EXE` | 12802 | `application/x-msdownload` | PASS, `25c27293821c5bd20928e6cd3f4e7fdd05fc681d3e694462b76cf1f88c1a6d4b` |
| `ux-pause.bin` | 134217728 | `application/octet-stream` | PASS, `a626d17da2e502f5b4b8e3ebd23f0bf9daef6255688d8e0bb482b3ae3794a682` |
| `ux-reload.bin` | 134217728 | `application/octet-stream` | PASS, `a626d17da2e502f5b4b8e3ebd23f0bf9daef6255688d8e0bb482b3ae3794a682` |
| `ux-network.bin` | 134217728 | `application/octet-stream` | PASS, `a626d17da2e502f5b4b8e3ebd23f0bf9daef6255688d8e0bb482b3ae3794a682` |
| `ux-sibling.bin` | 134217728 | `application/octet-stream` | PASS, `a626d17da2e502f5b4b8e3ebd23f0bf9daef6255688d8e0bb482b3ae3794a682` |
| `ux-safari-resume.bin` | 134217728 | `application/octet-stream` | PASS, `a626d17da2e502f5b4b8e3ebd23f0bf9daef6255688d8e0bb482b3ae3794a682` |
| `ux-safari-text.txt` | 24 | `text/plain` | PASS, `e8e926418ad3270d894e6353036f7df60342ffdb7e893451f254a7e02b094372` |
| `ux-safari-small.BIN` | 262144 | `application/octet-stream` | PASS, `2312394bd99545d9de131c24efb781e765ac1aec243f2ed9347597a793a415e9` |
| `ux-429.bin` | 134217728 | `application/octet-stream` | PASS, `a626d17da2e502f5b4b8e3ebd23f0bf9daef6255688d8e0bb482b3ae3794a682` |
| `ux-policy.dmg` | 768 | `application/octet-stream` | PASS, `f3a25aa93aa2fbba28d79260535bbd6a5eb0fc1c24a8b0f04e12b484c1dfe363` |
| `ux-policy.iso` | 768 | `application/octet-stream` | PASS, `f3a25aa93aa2fbba28d79260535bbd6a5eb0fc1c24a8b0f04e12b484c1dfe363` |
| `ux-policy.zip` | 768 | `application/octet-stream` | PASS, `f3a25aa93aa2fbba28d79260535bbd6a5eb0fc1c24a8b0f04e12b484c1dfe363` |
| `ux-policy.apk` | 768 | `application/octet-stream` | PASS, `f3a25aa93aa2fbba28d79260535bbd6a5eb0fc1c24a8b0f04e12b484c1dfe363` |
| `ux-policy.unknown` | 768 | `application/octet-stream` | PASS, `f3a25aa93aa2fbba28d79260535bbd6a5eb0fc1c24a8b0f04e12b484c1dfe363` |
| `ux-policy-noext` | 768 | `application/octet-stream` | PASS, `f3a25aa93aa2fbba28d79260535bbd6a5eb0fc1c24a8b0f04e12b484c1dfe363` |
| `ux-policy.txt` | 29 | `text/plain` | PASS, `d312685d6a89a5f16b521e0a1b876399263ee2ef593143bde00101fc248194f9` |
| `ux-policy.png` | 68 | `image/png` | PASS, `431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460` |
| `ux-network-check.bin` | 134217728 | `application/octet-stream` | PASS, `a626d17da2e502f5b4b8e3ebd23f0bf9daef6255688d8e0bb482b3ae3794a682` |

Пустой файл: отдельная ошибка «Пустые файлы пока не поддерживаются»; сессия не создаётся. Исходные байты fixtures сверены в fixture-hash-verification.json; скачанные через UI BIN, неизвестный тип, no-extension и128MiB — в download-hashes.json. Полный снимок34файлов со всеми дубликатами — runtime-before-cleanup.json. MIME от picker для неизвестного расширения может быть пустым; неизвестные MIME и несовпадение MIME с расширением также покрыты backend regression tests. Паттерн-байты под именами ISO/DMG/APK/ZIP намеренно не являются валидными образами/архивами: формат содержимого не управляет допуском.
