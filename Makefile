.PHONY: build test clippy fmt coverage clean

build:
	stellar contract build

test:
	cargo test --package mintergateway

clippy:
	cargo clippy --package mintergateway -- -D warnings

fmt:
	cargo fmt --all

coverage:
	cargo llvm-cov --package mintergateway --ignore-filename-regex 'test'

clean:
	cargo clean
	rm -rf coverage/
