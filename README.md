# API for Apple Silicon

This repository contains the source for a macOS port of API 1.0.15, including the current managed Claude/Gemini chat and the original Cockpit native account-switching commands.

Run **Actions → Build API for Apple Silicon → Run workflow** to compile on a GitHub-hosted Mac. The target is Apple Silicon on macOS 13 or later, matching [Electron 44's minimum macOS version](https://www.electronjs.org/blog/electron-44-0). The workflow packages a `.dmg` and `.zip`, checks ARM64 native modules and framework symlinks, verifies the ad-hoc code signature, and tests Keychain access plus the authenticated native-engine connection. It also verifies both chat protocols against an isolated mock gateway, streaming replies, restarting with saved conversations, user isolation, window resizing and restoration. It does not contact the home Raspberry Pi or perform real model calls.

The macOS build has not been executed at the time of this initial preparation. An archive or successful static check is not a runtime acceptance result. Download artifacts only from a successful workflow that includes `macos-smoke.json` and `macos-chat-smoke.json`.

The initial trial package is not Apple Developer ID notarized. At the user's request this macOS edition has no automatic updates, version-check action, or automatic-download preference. Future macOS upgrades require a new installer; the Windows updater is unchanged. Real gateway conversations and original-client switching need acceptance on the target Mac after the build succeeds.

Credentials are entered by users after installation and protected by the macOS Keychain. Distributed Keys, account tokens, Raspberry Pi credentials and update private keys are excluded from the source and artifacts.

Embedded upstream Google OAuth client secrets and the Windsurf Firebase application key are removed from this Mac build source. The hidden helper exposes only the existing GPT/Claude gateway switching commands; Google OAuth, Antigravity, Windsurf and Gemini CLI account login are outside this product. Embedded Gemini chat uses the Raspberry Pi gateway and the user's distributed Key.

See [构建说明.txt](构建说明.txt) for Chinese instructions and the current capability boundaries. Cherry Studio source is AGPL-3.0; Cockpit Tools source retains CC-BY-NC-SA-4.0. Original licenses are included with their corresponding sources.
