# Third-party notices

The MIT License in `LICENSE` covers the source code only. The following material is included
under its own licence.

## Audio (`audio/`)

| Files | Source | Licence |
|---|---|---|
| `voice_opera.wav`, `choir_pavane.wav`, `bassoon.wav`, `viol.wav`, `trumpet.wav`, `pistol.wav` | OpenAIR Anechoic Database, University of York (openairlib.net), via Zenodo [10.5281/zenodo.1186905](https://doi.org/10.5281/zenodo.1186905) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| `speech.wav`, `drum.wav`, `ref_court_101.wav`, `ref_court_105.wav` | Racquetball-court impulse-response study, Zenodo [10.5281/zenodo.15739328](https://doi.org/10.5281/zenodo.15739328) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `clap.wav` | Anechoic Handclaps, Aalto University, Zenodo [10.5281/zenodo.22892926](https://doi.org/10.5281/zenodo.22892926) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |

Changes: the clips were trimmed, converted to 48 kHz mono and normalised; the measured impulse
responses were trimmed to about 5 s. The CC BY-SA 4.0 clips are adaptations and are shared under
CC BY-SA 4.0. See `audio/LICENSES.md` for per-file descriptions.

## Data

- Absorption coefficients: pyroomacoustics `materials.json` (MIT, © LCAV, EPFL; values after
  Vorländer, *Auralization*, annex), RoomTreat (CC BY 4.0), sengpielaudio.
- Racquetball-court geometry and measured T30/C80 values: Zenodo 15739328 (CC BY 4.0).

## Libraries

- three.js r160 (MIT, © three.js authors), loaded at runtime from jsDelivr; not redistributed here.
