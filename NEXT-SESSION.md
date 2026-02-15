# Next Session

## First Task: Serve Wiki Dashboard from Render Instance

The wiki dashboard needs to be served from the Render instance at the `/wiki` route to avoid CORS issues. The React component exists at `context-wiki.jsx`. Bundle it with the existing Express server in `web-demo.js` so it's served as a built-in page (same pattern as `/` and `/ingest`).
