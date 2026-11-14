# Third-party notices

The MIT License in `LICENSE` covers the source code only. The following material is included
under its own licence.

## Audio (`audio/`)

| Files | Source | Licence |
|---|---|---|
| `voice_opera.wav`, `choir_pavane.wav`, `bassoon.wav`, `bassoon2.wav`, `viol.wav`, `trumpet.wav`, `trumpet_handel.wav`, `pistol.wav` | OpenAIR Anechoic Database, University of York (openairlib.net), via Zenodo [10.5281/zenodo.1186905](https://doi.org/10.5281/zenodo.1186905) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| `speech.wav`, `drum.wav`, `ref_court_101.wav`, `ref_court_105.wav` | Racquetball-court impulse-response study, Zenodo [10.5281/zenodo.15739328](https://doi.org/10.5281/zenodo.15739328) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `clap.wav` | Anechoic Handclaps, Aalto University, Zenodo [10.5281/zenodo.22892926](https://doi.org/10.5281/zenodo.22892926) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `speech_long_f.wav`, `speech_long_m.wav` | CSTR VCTK Corpus (Yamagishi, Veaux, MacDonald 2019, [doi:10.7488/ds/2645](https://doi.org/10.7488/ds/2645)), speakers p257 and p232 from the clean test set of Valentini-Botinhao (2017), University of Edinburgh, [doi:10.7488/ds/2117](https://doi.org/10.7488/ds/2117) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `singing.wav` | VocalSet (Wilkins, Seetharaman, Wahl, Pardo, ISMIR 2018), `female6/excerpts/vibrato/f6_caro_vibrato.wav`, Zenodo [10.5281/zenodo.1193957](https://doi.org/10.5281/zenodo.1193957) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `drum_long.wav` | Groove MIDI Dataset, Google LLC (Gillick, Roberts, Engel, Eck, Bamman, ICML 2019), `drummer1/session3/7_dance-disco_120_beat_4-4.wav` | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |

Changes: the clips were trimmed, converted to mono (48 kHz, or 32 kHz for clips longer than 12 s)
and normalised. The VCTK utterances were trimmed of silence and joined with 0.35 s gaps. The
measured impulse responses were trimmed to about 5 s. The CC BY-SA 4.0 clips are adaptations and are shared under
CC BY-SA 4.0. See `audio/LICENSES.md` for per-file descriptions.

## Data

- Absorption coefficients: pyroomacoustics `materials.json` (MIT, © LCAV, EPFL; values after
  Vorländer, *Auralization*, annex), RoomTreat (CC BY 4.0), sengpielaudio.
- Racquetball-court geometry and measured T30/C80 values: Zenodo 15739328 (CC BY 4.0).

## Libraries

- three.js r160 (MIT, © three.js authors), loaded at runtime from jsDelivr; not redistributed here.
