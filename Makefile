.PHONY: build test clippy fmt coverage clean

# Embeds the same contract meta as the release workflow so local-build
# deploys (WASM_PATH + ALLOW_UNATTESTED_WASM=1) are SEP-0055 discoverable
# on Lab / stellar.expert. source_repo is bare per SEP-0055 — the commit
# binding comes from the GitHub attestation for release builds; local
# builds won't have an attestation but the source_repo still points
# explorers at the right repo.
build:
	stellar contract build \
		--meta source_repo=github:m0-foundation/stellar-minter-gateway \
		--meta home_domain=m0.org

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
