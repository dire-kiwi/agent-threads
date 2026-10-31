# make gen: regenerate everything made from spec/schema (the bundle, and the TS, Go and Rust types).
# make check-gen: fail if that changes anything, i.e. the generated code isn't up to date (CI runs it).
# make test: build and test all three languages, and the fixtures' tools (make test-spec).

GENERATED := spec/protocol.schema.json ts/packages/protocol/src/generated.ts go/protocol/protocol_gen.go rust/agent-threads/src/protocol.rs

.PHONY: gen gen-bundle gen-ts gen-go gen-rust check-gen test test-spec test-ts test-go test-rust

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

test: test-spec test-ts test-go test-rust

test-spec:
	node --test spec/tools/test/

test-ts:
	cd ts && pnpm build && pnpm test

test-go:
	cd go && go vet ./... && go test ./...

test-rust:
	cd rust && cargo test --locked && cargo clippy --locked --all-targets -- -D warnings && cargo fmt --check
