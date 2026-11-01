# make gen: regenerate everything made from spec/schema (the bundle, and the TS, Go and Rust types).
# make check-gen: fail if that changes anything, i.e. the generated code isn't up to date (CI runs it).
# make test: build and test all three languages, the shim, the fixtures' tools (make test-spec),
# and the Rust chat example.

GENERATED := spec/protocol.schema.json ts/packages/protocol/src/generated.ts ts/packages/protocol/src/schema.ts go/protocol/protocol_gen.go go/protocol/protocol.schema.json rust/agent-threads/src/protocol.rs

.PHONY: gen gen-bundle gen-ts gen-go gen-rust check-gen test test-spec test-ts test-go test-rust test-chat-rust test-shim shim

gen: gen-bundle gen-ts gen-go gen-rust

gen-bundle:
	node scripts/bundle-schema.mjs

gen-ts: gen-bundle
	cd ts && pnpm --filter @dire-kiwi/agent-threads-protocol gen

gen-go: gen-bundle
	cd go && go run ./internal/gen

gen-rust: gen-bundle
	cd rust && cargo run --quiet -p codegen && cargo fmt -p agent-threads

check-gen: gen
	@git add -N $(GENERATED)
	@git diff --exit-code -- $(GENERATED) || { echo "The generated code is out of date: run make gen and commit the result." >&2; exit 1; }

test: test-spec test-shim test-ts test-go test-rust test-chat-rust

test-spec:
	node --test 'spec/tools/test/*.test.mjs'

# The Node backend's tests run agent-threads-shim.
test-ts: shim
	cd ts && pnpm build && pnpm test

# The Go backend's tests run agent-threads-shim and the fake CLI (node).
test-go: shim
	cd go && go vet ./... && go test ./...
	cd examples/chat-go && go vet ./... && go test ./...

# The Rust backend's tests run the fake CLI and its mini CLIs with node, and build the shim.
test-rust:
	cd rust && cargo test --locked && cargo clippy --locked --all-targets -- -D warnings && cargo fmt --check

test-chat-rust:
	cd examples/chat-rust && cargo test --locked && cargo clippy --locked --all-targets -- -D warnings && cargo fmt --check

shim:
	cd shim && cargo build --locked

test-shim:
	cd shim && cargo test --locked && cargo clippy --locked --all-targets -- -D warnings && cargo fmt --check
