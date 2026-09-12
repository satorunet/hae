#!/bin/sh
# Build flybrain.wasm from src/brain.c.
#
# Needs a C compiler that targets wasm32. The zero-install route is Zig's
# bundled clang:   python3 -m pip install ziglang
# (set ZIG to override, e.g. ZIG="zig" if zig is on PATH)
set -e
cd "$(dirname "$0")"
ZIG="${ZIG:-python3 -m ziglang}"
$ZIG cc -target wasm32-freestanding -O3 -mbulk-memory -nostdlib \
    -Wl,--no-entry -Wl,--export-dynamic \
    -Wl,--initial-memory=2097152 -Wl,--max-memory=2147483648 \
    -Wl,--strip-all \
    -o flybrain.wasm src/brain.c
ls -l flybrain.wasm
