# Email Verifier

Simple bulk email verification script using the Reoon Email Verifier API.

## What this does

- Reads input leads from `input/data.json` (an array of objects with an `email` field).
- Sends emails in bulk to the Reoon bulk verification API.
- Polls for results and writes verified records into `output/valid.json` and invalid ones into `output/invalid.json`.
- Supports resuming an in-progress bulk task via `output/task-info.json`.

## Setup

1. Install dependencies (uses Yarn):

```bash
yarn install
```

2. Create a `.env` file in the project root with your API key:

```env
REOON_API_KEY=your_api_key_here
```

3. Put your input data in `input/data.json`.

- The file should contain a JSON array of objects. Each object should include at least an `email` property, e.g.:

```json
[
  { "email": "alice@example.com", "name": "Alice" },
  { "email": "bob@example.com", "name": "Bob" }
]
```

## Run

Start the script with:

```bash
yarn start
```

This will run `email-verifier.js` which will process the emails and write outputs to the `output/` folder.

## Output

- `output/valid.json` — array of lead objects marked valid
- `output/invalid.json` — array of lead objects marked invalid
- `output/task-info.json` — saved task metadata for resumability

## Notes

- The script expects `input/data.json` and writes output files to the `output/` directory.
- If you need to restart processing from scratch, remove `output/task-info.json`.
- The script requires a valid API key with enough credits.

## Troubleshooting

- If you see an error about `REOON_API_KEY` missing, check your `.env` file is present and correct.
- Ensure `input/data.json` is valid JSON.
