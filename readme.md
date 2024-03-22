# ZenFS Fetch Backend

A [ZenFS](https://github.com/zen-fs/core) backend for fetching files using HTTP.

> [!IMPORTANT]
> Please read the ZenFS core documentation

For more information, see the [API documentation](https://zen-fs.github.io/fetch).

## Usage

> [!NOTE]
> The examples are written in ESM. If you are using CJS, you can `require` the package. If running in a browser you can add a script tag to your HTML pointing to the `browser.min.js` and use ZenFS Fetch via the global `ZenFS_Fetch` object.

```js
import { configure, fs } from '@zenfs/core';
import { Fetch } from '@zenfs/fetch';

await configure({ backend: Fetch, baseUrl: 'https://example.com/' });

const contents = await fs.readFile('/test.txt', 'utf-8');
console.log(contents);
```
