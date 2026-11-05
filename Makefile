# make gen: regenerate everything made from spec/schema (the bundle, and the TS types).
# make check-gen: fail if that changes anything, i.e. the generated code isn't up to date (CI runs it).
# make test: build and test the TypeScript packages, the shim and the fixtures' tools (make test-spec).

GENERATED := spec/protocol.schema.json ts/packages/protocol/src/generated.ts ts/packages/protocol/src/schema.ts

.PHONY: gen gen-bundle gen-ts check-gen test test-spec test-ts test-shim shim

gen: gen-bundle gen-ts

gen-bundle:
	node scripts/bundle-schema.mjs

gen-ts: gen-bundle
	cd ts && pnpm --filter @dire-kiwi/agent-threads-protocol gen

check-gen: gen
	@git add -N $(GENERATED)
	@git diff --exit-code -- $(GENERATED) || { echo "The generated code is out of date: run make gen and commit the result." >&2; exit 1; }

test: test-spec test-shim test-ts

test-spec:
	node --test 'spec/tools/test/*.test.mjs'

# The Node backend's tests run agent-threads-shim.
test-ts: shim
	cd ts && pnpm build && pnpm test

shim:
	cd shim && cargo build --locked

test-shim:
	cd shim && cargo test --locked && cargo clippy --locked --all-targets -- -D warnings && cargo fmt --check
