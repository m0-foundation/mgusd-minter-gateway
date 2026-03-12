.PHONY: build test coverage clean

build:
	stellar contract build

test:
	cargo test --package mintergateway

coverage:
	cargo llvm-cov --package mintergateway --ignore-filename-regex 'test'

clean:
	cargo clean
	rm -rf coverage/
