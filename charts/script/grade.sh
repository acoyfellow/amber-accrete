#!/usr/bin/env sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p test/accept
cp "$here/hidden/closer.test.mjs" test/accept/
sed -i.bak "s|../harness.mjs|../harness.mjs|" test/accept/closer.test.mjs && rm -f test/accept/closer.test.mjs.bak
node --import tsx --test --test-reporter=dot test/accept/closer.test.mjs
hidden=$?
rm -rf test/accept
node --import tsx --test --test-reporter=dot >/dev/null 2>&1
existing=$?
if [ "$hidden" -eq 0 ] && [ "$existing" -eq 0 ]; then
  echo "pass: hidden tests and existing tests"
  exit 0
fi
echo "fail: hidden=$hidden existing=$existing"
exit 1
