.PHONY: build test coverage fuzz fuzz-math clean

build:
	stellar contract build

test:
	cargo test --package yieldtoone

coverage:
	cargo llvm-cov --package yieldtoone --ignore-filename-regex 'test'

fuzz:
	cd contracts/yieldtoone && cargo +nightly fuzz run fuzz_yield_operations -- -max_total_time=300

fuzz-math:
	cd contracts/yieldtoone && cargo +nightly fuzz run fuzz_continuous_index -- -max_total_time=120

clean:
	cargo clean
	rm -rf coverage/
