# tests

Runs the real `assets/js/market.js` against a synthetic chain. Nothing here is
a reimplementation: the harness replaces only what the module talks to - the
chain, `localStorage`, `fetch` - and imports the shipped file.

    node tests/run.mjs

No dependencies, about a second.

## Why these cases

Every one of them corresponds to a bug that reached the deployed wallet and was
found by taking a screenshot and reading a console log. The routing layer is
pure arithmetic over data structures, so all of it could have been caught here
instead.

## What is covered

`run.mjs` - the pricing and routing layer, against the real `market.js`.

`envelopes.mjs` - the message that gets signed, for all three pool dialects.
This is the only layer where being wrong costs money rather than credibility,
and none of the three contracts publishes a schema: every shape here was read
off real transactions. `swap.js` attaches DOM handlers on load, so rather than
bring in a DOM, `envelope()` is lifted out of the shipped file by brace matching
and run against stubs. Rename or rewrite it and these go red, which is the
intent.

## Adding a case

`fixture.mjs` is a small market: two exchanges, one published by the feed and
one discoverable only by walking its factory, plus the pools that made trouble -
a near-empty pool that is some token's only direct route out, and a cluster
whose way to LUNC runs through a wrapper.

`loadMarket()` gives a fresh module instance each time, because the module keeps
a session in its own scope. Pass `{ storage }` from a previous load to test what
happens on a second open.

## Checking that a test can fail

A green suite proves nothing on its own. Put a bug back and confirm something
goes red:

    # rank a route by its widest leg instead of its narrowest
    sed -i 's/Math.min(legOne, two.far)/Math.max(legOne, two.far)/' assets/js/market.js
    node tests/run.mjs        # must fail
    git checkout assets/js/market.js
