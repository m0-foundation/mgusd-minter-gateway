.PHONY: build test coverage clean

build:
	stellar contract build

test:
	cargo test --package yieldtoone

coverage:
	cargo llvm-cov --package yieldtoone --ignore-filename-regex 'test'

clean:
	cargo clean
	rm -rf coverage/
