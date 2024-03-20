# BrowserFS Fetch Backend

A [BrowserFS](https://github.com/browser-fs/core) backend for fetching files using HTTP.

> [!IMPORTANT]
> Please read the BrowserFS core documentation

For more information, see the [API documentation](https://browser-fs.github.io/fetch).

## Usage

> [!NOTE]
> The examples are written in ESM. If you are using CJS, you can `require` the package. If running in a browser you can add a script tag to your HTML pointing to the `browser.min.js` and use BrowserFS Fetch via the global `BrowserFS_Fetch` object.

```js
import { configure, fs } from '@browserfs/core';
import { Fetch } from '@browserfs/fetch';

await configure({ backend: Fetch, baseUrl: 'https://example.com/' });

const contents = await fs.readFile('/test.txt', 'utf-8');
console.log(contents);
```
