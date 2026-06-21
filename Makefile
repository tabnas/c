# Build and test the @tabnas/c TypeScript package (in ts/).
#
# Local build/test resolve the unpublished @tabnas siblings via the
# file: devDependencies in ts/package.json (sibling checkouts of
# parser, jsonic and expr — see AGENTS.md).

.PHONY: all build test clean reset

all: build test

build:
	cd ts && npm run build

test:
	cd ts && npm test

clean:
	rm -rf ts/dist ts/dist-test

reset:
	cd ts && npm run reset
