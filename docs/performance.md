# Startup and size

The entry point only registers `/provider`. The form, saved settings, and network helpers are imported when the command opens. Model discovery and key checks run only when requested. Normal prompts use Pi's own provider transports.

## Measured startup

Checked on Linux ARM64 with Pi-Bolt 1.0.7 / Pi 1.4.0:

| Loading mode | Median startup |
|---|---:|
| Pi-Bolt baseline | 44.7 ms |
| Extension loaded from TypeScript | 76.0 ms |
| Extension compiled into Pi-Bolt | 46.7 ms |

Method: 14 alternating runs per mode, identical temporary model settings and dummy keys, offline `--list-models` startup, excluding the first two runs from each median. Source mode created a jiti cache entry; compiled mode did not. A separate local-server check confirmed that startup made no provider requests.

Measured again for version 0.2.0. Source mode paid about 31 ms for Pi-Bolt's source-extension loader. Compiled mode added about 2 ms in this check. These figures cover offline model-list startup on this machine; interactive startup, cache state, and other machines can vary. They are not a promise of exactly zero overhead.

## Recommended install

```sh
pi-bolt install git:github.com/Ansh99999/pi-bolt-provider
pi-bolt compile
```

Compilation is Pi-Bolt's existing feature. It removes the runtime TypeScript loader for compiled extensions. The first compile downloads and checks Pi-Bolt's runtime and compile kit, about 52 MB on Linux; later compiles reuse the cache. No compiler runs while opening `/provider` or during normal prompts.

For development, source mode remains available:

```sh
pi-bolt -e ./index.ts
```

## Package and checks

The version 0.2.0 package is about 37 KB compressed, with no runtime dependencies to install. Pi supplies its own terminal components and extension API. Development packages and tests are excluded from the package archive.

The extension was compiled into a separate output folder. Its terminal wizard was checked using temporary settings: add a provider, add a model, mark it as default, confirm, and read back the native saved settings. Version 0.2.0 was also checked for provider searching/editing, saved thinking levels, selecting max through `/thinking`, and cancelling deletion. Native Pi conversation tests verify immediate scope changes, retained messages, and fallback after deleting the current provider. Key masking was checked against terminal output. Source-mode testing also used a copy without `node_modules`.

See Pi-Bolt's [plugin compilation guide](https://github.com/opensec-git/Pi-Bolt/blob/pi-bolt/docs/PLUGINS.md) for compiler options and platform support.
