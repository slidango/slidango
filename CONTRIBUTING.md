# Contributing to Slidango

Thanks for wanting to help. Slidango is a small, private open-source project; contributions of any size are welcome: bug reports, ideas, docs, code, templates.

## Before you start

- **Bugs and ideas:** open an [issue](https://github.com/slidango/slidango/issues). For bugs, say what you did, what you expected and what happened; a screenshot or the server log helps.
- **Larger changes:** open an issue first and describe the idea. It saves you work if the direction doesn't fit.
- **Security issues:** please don't open a public issue. Report them privately through [GitHub's security advisories](https://github.com/slidango/slidango/security/advisories/new).

## Working on the code

The [development guide](docs/development.md) gets you running locally: setup, project layout and a tour for testing by hand. Before you open a pull request, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
```

CI runs the same checks on every pull request.

- Keep a pull request to one change, with tests for new behaviour.
- The UI and docs are in English: short sentences, concrete, no superlatives, like the rest of the app.
- Commit messages: a short summary line in the imperative, then what changed and why.

## Templates

Slide templates are Slidev themes. The format is described in [`docs/template.md`](docs/template.md); the built-in Slidango template in [`theme/`](theme) is a good starting point.

## License of contributions

Slidango is licensed under the [MIT License](LICENSE). By submitting a contribution, you agree that:

1. it is your own work, or you have the right to submit it;
2. it is licensed under the project's license (currently MIT); and
3. the maintainer may relicense it as part of Slidango under another open-source license approved by the [Open Source Initiative](https://opensource.org/licenses), should the project's license change in the future.

## Conduct

Be kind and assume good intent. Criticism goes to the work, never to the person. Harassment of any kind is not tolerated; the maintainer may remove contributions or block participants who break this.
