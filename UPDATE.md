# Updating the public trip map

- Repo: https://github.com/CrypThias6/tm-om4crwetxstl (public, unguessable name, no description)
- Live: https://crypthias6.github.io/tm-om4crwetxstl/  (GitHub Pages, branch `gh-pages`, root; `main` is a mirror)
- This folder is GENERATED. Never edit it by hand. The full private version stays in /workspace/trip-map.

## One command

```bash
/workspace/trip-map/tools/publish_public.sh "Update: <what changed>"
```

It runs, in order, and stops at the first failure:
1. `python3 /workspace/trip-map/tools/build_sg_trip.py` (private data from /workspace/solo-trip/sg_trip_logistics.json)
2. `python3 /workspace/trip-map/tools/build_public.py --out /workspace/trip-map-public` (redacted copy)
3. `python3 /workspace/trip-map/tools/leak_check.py /workspace/trip-map-public` (exit 1 = DO NOT PUBLISH)
4. `git commit` + `git push -f origin HEAD:main HEAD:gh-pages`

## If the box has no git credentials (current state: `gh` not logged in)

Steps 1 to 3 still run; the script exits 2 after the leak check. Then push the files in
/workspace/trip-map-public with the GitHub connector (`push_files`, owner CrypThias6,
repo tm-om4crwetxstl), once to branch `gh-pages` and once to `main`, passing each file as
`"$file:/workspace/trip-map-public/<path>"`. Files: index.html, app.js, styles.css,
data/trip.js, robots.txt, .nojekyll, UPDATE.md. Then re-run the leak check on the pushed
tree and curl https://crypthias6.github.io/tm-om4crwetxstl/data/trip.js.

## What the public build strips

Booking refs / PNRs / order numbers, e-ticket numbers, emails, passport wording, surnames
and full names, private file names, manage-booking links, and the old Fintech + NZ plan
(excluded entirely). Flight numbers, times, options, prices and public links stay.
Pages carries `noindex` and robots.txt disallows all crawling.
