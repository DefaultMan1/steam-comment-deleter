# Contributing

Bug reports, small fixes, and clearer instructions are welcome.

## Report a bug

Include your browser and Tampermonkey versions, the steps you took, what happened, and the message shown under Activity. Do not include credentials or personal comment text. A screenshot with personal details removed can help.

## Make a change

Keep the distributed tool in one readable userscript. Avoid runtime dependencies. Explain the problem your change solves and how you checked it.

Run:

```sh
npm ci
npx playwright install chromium firefox
npm test
npm run test:browser:firefox
```

Add a regression test when changing deletion, cancellation, filtering, or pagination behaviour. Use fixtures for destructive scenarios. Never use somebody else's comments as test data without permission.

Documentation and visual improvements are welcome too. Keep installation steps short and verify that links work.
