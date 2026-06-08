# Vimeo Owned Video Downloader

A Chrome extension to download Vimeo videos you own or have been granted access to.

## How it works

This extension uses the **same technique as the official Vimeo player** — it intercepts the XHR/fetch calls that the Vimeo player itself makes to load video configuration, then extracts the direct MP4 download links from the response.

This avoids 403 errors because:
- We never make unauthorized API calls
- We only capture data that your browser already receives as a logged-in user
- The download link comes from Vimeo's own player config

## Architecture

```
content-inject.js   →  injects ajax-listener.js into the page's MAIN world
ajax-listener.js    →  patches XHR + fetch to capture Vimeo config responses
content-main.js     →  bridges captured data from page → popup
background.js       →  handles downloads + proxies some requests
popup.js/html       →  UI showing available quality options
```

## Installation

1. Clone or download this repository
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select this folder

## Usage

1. Navigate to a Vimeo video page
2. **Let the video start playing** (this triggers the config XHR)
3. Click the extension icon
4. Select your desired quality and click **Save**

## Notes

- Only works for videos you have access to (owned, shared with you, or public)
- Requires the video to load in the player first
- Some videos use HLS streaming only and may not have direct MP4 links
