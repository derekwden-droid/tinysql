# TinySQL plugin privacy policy

Last updated: October 3, 2026

The TinySQL plugin for Claude collects no data. It has no servers, no accounts, no analytics and
no telemetry, and it never connects to the network.

## What the plugin accesses

When Claude calls one of the plugin's tools, the plugin reads the CSV files named in that call from
your computer. It reads only files whose names end in `.csv`. It does not search your disk or open
any file it was not given.

## What happens to that data

The plugin loads the files into memory, runs the SQL, and returns the result to Claude as the
tool's output. Everything it loaded is discarded when the call returns. The plugin writes no files
and keeps no logs, caches or copies.

The tool output becomes part of your conversation with Claude, like any other tool result. How
Anthropic handles your conversations is covered by Anthropic's own privacy policy, not this one.

## Retention

None. Nothing outlives the tool call that loaded it.

## Changes and contact

Changes to this policy are made in this file and recorded in the repository's history. Questions go
to [github.com/derekwden-droid/tinysql/issues](https://github.com/derekwden-droid/tinysql/issues).
