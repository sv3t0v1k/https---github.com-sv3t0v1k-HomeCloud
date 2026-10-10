#!/bin/sh
set -eu
[ "$(uname -s)" = Linux ] || { echo 'Secure filesystem build requires Linux' >&2; exit 1; }
cc -std=c11 -O2 -fPIC -shared -Wall -Wextra -Werror -Wno-misleading-indentation -I/usr/local/include/node native/secure-fs.c -o native/secure-fs.node
