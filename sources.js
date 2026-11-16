{
  "_help": "Edit this file on GitHub to fix a dead download service. Every running bot reads it within an hour, no redeploy needed. version: change it when you edit, so the bot reports the change. disabled: names of sources to switch off. music: list of audio services ({name, get} or {name, post, form}); {u} is replaced by the YouTube link. community: per site, a list of [name, address]; {u} is the link, {q} is the video quality. A site that is not listed keeps the built-in list. Only https addresses that contain {u} are accepted.",
  "version": 1,
  "disabled": [],
  "music": [
    {
      "name": "ytmp3.ge",
      "post": "https://ytmp3.ge/api/convert",
      "form": {
        "youtube_url": "{u}"
      }
    },
    {
      "name": "siputzx",
      "get": "https://api.siputzx.my.id/api/d/ytmp3?url={u}"
    },
    {
      "name": "vreden",
      "get": "https://api.vreden.my.id/api/v1/download/youtube/audio?quality=128&url={u}"
    },
    {
      "name": "nekolabs",
      "get": "https://api.nekolabs.web.id/downloader/youtube/v1?format=mp3&url={u}"
    },
    {
      "name": "davidcyril",
      "get": "https://apis.davidcyriltech.my.id/youtube/mp3?url={u}"
    },
    {
      "name": "agatz",
      "get": "https://api.agatz.xyz/api/ytmp3?url={u}"
    }
  ],
  "community": {
    "youtube": [
      [
        "siputzx",
        "https://api.siputzx.my.id/api/d/ytmp4?url={u}"
      ],
      [
        "vreden",
        "https://api.vreden.my.id/api/v1/download/youtube/video?quality={q}&url={u}"
      ],
      [
        "nekolabs",
        "https://api.nekolabs.web.id/downloader/youtube/v1?format={q}&url={u}"
      ],
      [
        "davidcyril",
        "https://apis.davidcyriltech.my.id/youtube/mp4?url={u}"
      ],
      [
        "agatz",
        "https://api.agatz.xyz/api/ytmp4?url={u}"
      ]
    ],
    "instagram": [
      [
        "siputzx",
        "https://api.siputzx.my.id/api/d/igdl?url={u}"
      ],
      [
        "vreden",
        "https://api.vreden.my.id/api/v1/download/instagram?url={u}"
      ],
      [
        "davidcyril",
        "https://apis.davidcyriltech.my.id/instagram?url={u}"
      ],
      [
        "agatz",
        "https://api.agatz.xyz/api/instagram?url={u}"
      ]
    ],
    "facebook": [
      [
        "siputzx",
        "https://api.siputzx.my.id/api/d/facebook?url={u}"
      ],
      [
        "vreden",
        "https://api.vreden.my.id/api/v1/download/facebook?url={u}"
      ],
      [
        "davidcyril",
        "https://apis.davidcyriltech.my.id/facebook?url={u}"
      ],
      [
        "agatz",
        "https://api.agatz.xyz/api/facebook?url={u}"
      ]
    ],
    "tiktok": [
      [
        "siputzx",
        "https://api.siputzx.my.id/api/d/tiktok?url={u}"
      ],
      [
        "vreden",
        "https://api.vreden.my.id/api/v1/download/tiktok?url={u}"
      ],
      [
        "davidcyril",
        "https://apis.davidcyriltech.my.id/tiktok?url={u}"
      ]
    ],
    "twitter": [
      [
        "siputzx",
        "https://api.siputzx.my.id/api/d/twitter?url={u}"
      ],
      [
        "vreden",
        "https://api.vreden.my.id/api/v1/download/twitter?url={u}"
      ],
      [
        "davidcyril",
        "https://apis.davidcyriltech.my.id/twitter?url={u}"
      ]
    ],
    "pinterest": [
      [
        "vreden",
        "https://api.vreden.my.id/api/v1/download/pinterest?url={u}"
      ],
      [
        "siputzx",
        "https://api.siputzx.my.id/api/d/pinterest?url={u}"
      ]
    ],
    "threads": [
      [
        "vreden",
        "https://api.vreden.my.id/api/v1/download/threads?url={u}"
      ]
    ],
    "terabox": [
      [
        "vreden",
        "https://api.vreden.my.id/api/v1/download/terabox?url={u}"
      ],
      [
        "siputzx",
        "https://api.siputzx.my.id/api/d/terabox?url={u}"
      ]
    ]
  }
}
