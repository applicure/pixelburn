/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/pixel.json`.
 */
export type Pixel = {
  "address": "A4uaXC9sU3UrbqcPZL4ZJMd2aKzmo5Rq4yDvRm8gpTS",
  "metadata": {
    "name": "pixel",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "The Million Pixel Burn on-chain program"
  },
  "instructions": [
    {
      "name": "acceptAdmin",
      "discriminator": [
        112,
        42,
        45,
        90,
        116,
        181,
        13,
        170
      ],
      "accounts": [
        {
          "name": "newAdmin",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "bidFinalAuction",
      "discriminator": [
        192,
        203,
        44,
        28,
        186,
        64,
        52,
        63
      ],
      "accounts": [
        {
          "name": "bidder",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              }
            ]
          }
        },
        {
          "name": "previousBidder",
          "writable": true,
          "optional": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "lamports",
          "type": "u64"
        }
      ]
    },
    {
      "name": "buyWithSol",
      "discriminator": [
        49,
        57,
        124,
        194,
        240,
        20,
        216,
        102
      ],
      "accounts": [
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "canvas",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  97,
                  110,
                  118,
                  97,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "ad",
          "writable": true
        },
        {
          "name": "treasury",
          "writable": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "buybackVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  121,
                  98,
                  97,
                  99,
                  107,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "priceUpdate",
          "docs": [
            "Pyth receiver-owned PriceUpdateV2 (owner + discriminator checked by Account<>)."
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "x",
          "type": "u8"
        },
        {
          "name": "y",
          "type": "u8"
        },
        {
          "name": "w",
          "type": "u8"
        },
        {
          "name": "h",
          "type": "u8"
        },
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "link",
          "type": "string"
        },
        {
          "name": "imageUri",
          "type": "string"
        },
        {
          "name": "imageSha256",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "maxLamports",
          "type": "u64"
        }
      ]
    },
    {
      "name": "buyWithToken",
      "discriminator": [
        51,
        104,
        65,
        186,
        195,
        43,
        81,
        144
      ],
      "accounts": [
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "canvas",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  97,
                  110,
                  118,
                  97,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "ad",
          "writable": true
        },
        {
          "name": "tokenMint",
          "writable": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "buyerTokenAccount",
          "writable": true
        },
        {
          "name": "priceUpdate"
        },
        {
          "name": "priceSource"
        },
        {
          "name": "poolBaseVault",
          "optional": true
        },
        {
          "name": "poolQuoteVault",
          "optional": true
        },
        {
          "name": "tokenProgram",
          "relations": [
            "config"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "x",
          "type": "u8"
        },
        {
          "name": "y",
          "type": "u8"
        },
        {
          "name": "w",
          "type": "u8"
        },
        {
          "name": "h",
          "type": "u8"
        },
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "link",
          "type": "string"
        },
        {
          "name": "imageUri",
          "type": "string"
        },
        {
          "name": "imageSha256",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "maxTokens",
          "type": "u64"
        }
      ]
    },
    {
      "name": "crankTokenPrice",
      "discriminator": [
        151,
        85,
        177,
        141,
        248,
        221,
        203,
        251
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "priceSource"
        },
        {
          "name": "poolBaseVault",
          "optional": true
        },
        {
          "name": "poolQuoteVault",
          "optional": true
        }
      ],
      "args": []
    },
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "canvas",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  97,
                  110,
                  118,
                  97,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "buybackVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  121,
                  98,
                  97,
                  99,
                  107,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "tokenMint"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "program",
          "docs": [
            "Only the program's upgrade authority may initialise (prevents init front-running)."
          ],
          "address": "A4uaXC9sU3UrbqcPZL4ZJMd2aKzmo5Rq4yDvRm8gpTS"
        },
        {
          "name": "programData"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "initializeParams"
            }
          }
        }
      ]
    },
    {
      "name": "proposeAdmin",
      "discriminator": [
        121,
        214,
        199,
        212,
        87,
        39,
        117,
        234
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "recordBuybackBurn",
      "discriminator": [
        191,
        49,
        225,
        231,
        159,
        111,
        56,
        89
      ],
      "accounts": [
        {
          "name": "keeper",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "canvas",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  97,
                  110,
                  118,
                  97,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "buybackVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  121,
                  98,
                  97,
                  99,
                  107,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "tokenMint",
          "writable": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "keeperTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "relations": [
            "config"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "lamportsSpent",
          "type": "u64"
        },
        {
          "name": "tokensBurned",
          "type": "u64"
        }
      ]
    },
    {
      "name": "releaseBuyback",
      "discriminator": [
        237,
        108,
        58,
        146,
        76,
        179,
        181,
        40
      ],
      "accounts": [
        {
          "name": "keeper",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "buybackVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  121,
                  98,
                  97,
                  99,
                  107,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "lamports",
          "type": "u64"
        }
      ]
    },
    {
      "name": "restartFinalAuction",
      "discriminator": [
        240,
        203,
        8,
        46,
        1,
        131,
        41,
        6
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "setKeeper",
      "discriminator": [
        102,
        94,
        23,
        78,
        157,
        222,
        243,
        214
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "keeper",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setParams",
      "discriminator": [
        27,
        234,
        178,
        52,
        147,
        2,
        187,
        141
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "maxPriceAgeSecs",
          "type": "u64"
        },
        {
          "name": "buybackCapLamportsPerHour",
          "type": "u64"
        },
        {
          "name": "buybackMaxSlippageBps",
          "type": "u16"
        },
        {
          "name": "tokenBlocksCapPerHour",
          "type": "u16"
        }
      ]
    },
    {
      "name": "setPaused",
      "discriminator": [
        91,
        60,
        125,
        192,
        176,
        225,
        166,
        218
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "auction",
          "docs": [
            "paused duration so a pause can never decide the auction."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setPriceSource",
      "discriminator": [
        57,
        150,
        166,
        254,
        90,
        79,
        215,
        64
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "priceSource",
          "type": {
            "defined": {
              "name": "priceSource"
            }
          }
        },
        {
          "name": "initialEmaPriceSol",
          "type": "u128"
        }
      ]
    },
    {
      "name": "setTreasury",
      "discriminator": [
        57,
        97,
        196,
        95,
        195,
        206,
        106,
        136
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "treasury",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "settleFinalAuction",
      "discriminator": [
        143,
        90,
        218,
        54,
        17,
        211,
        98,
        143
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "canvas",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  97,
                  110,
                  118,
                  97,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              }
            ]
          }
        },
        {
          "name": "ad",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  100,
                  95,
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              }
            ]
          }
        },
        {
          "name": "buybackVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  121,
                  98,
                  97,
                  99,
                  107,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "startFinalAuction",
      "discriminator": [
        21,
        216,
        187,
        88,
        49,
        134,
        28,
        249
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "canvas",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  97,
                  110,
                  118,
                  97,
                  115
                ]
              }
            ]
          }
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "transferAd",
      "discriminator": [
        54,
        207,
        122,
        125,
        186,
        169,
        15,
        232
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "ad"
          ]
        },
        {
          "name": "ad",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "newOwner",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "updateAd",
      "discriminator": [
        28,
        63,
        46,
        111,
        92,
        161,
        247,
        193
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "ad"
          ]
        },
        {
          "name": "ad",
          "docs": [
            "Any program-owned `Ad` (owner + discriminator checked by Account<>); authority via has_one."
          ],
          "writable": true
        }
      ],
      "args": [
        {
          "name": "title",
          "type": "string"
        },
        {
          "name": "link",
          "type": "string"
        },
        {
          "name": "imageUri",
          "type": "string"
        },
        {
          "name": "imageSha256",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "ad",
      "discriminator": [
        81,
        91,
        73,
        106,
        215,
        137,
        214,
        47
      ]
    },
    {
      "name": "auction",
      "discriminator": [
        218,
        94,
        247,
        242,
        126,
        233,
        131,
        81
      ]
    },
    {
      "name": "canvas",
      "discriminator": [
        239,
        248,
        162,
        140,
        114,
        179,
        55,
        66
      ]
    },
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    }
  ],
  "events": [
    {
      "name": "adPurchased",
      "discriminator": [
        16,
        190,
        180,
        69,
        85,
        154,
        226,
        94
      ]
    },
    {
      "name": "adTransferred",
      "discriminator": [
        53,
        29,
        183,
        169,
        55,
        90,
        69,
        132
      ]
    },
    {
      "name": "adUpdated",
      "discriminator": [
        135,
        175,
        55,
        209,
        148,
        68,
        49,
        135
      ]
    },
    {
      "name": "auctionBid",
      "discriminator": [
        113,
        186,
        124,
        132,
        210,
        152,
        98,
        191
      ]
    },
    {
      "name": "auctionRestarted",
      "discriminator": [
        103,
        209,
        190,
        81,
        81,
        142,
        43,
        207
      ]
    },
    {
      "name": "auctionResumed",
      "discriminator": [
        250,
        92,
        69,
        194,
        76,
        157,
        45,
        233
      ]
    },
    {
      "name": "auctionSettled",
      "discriminator": [
        61,
        151,
        131,
        170,
        95,
        203,
        219,
        147
      ]
    },
    {
      "name": "auctionStarted",
      "discriminator": [
        126,
        97,
        193,
        56,
        72,
        162,
        162,
        64
      ]
    },
    {
      "name": "buybackBurned",
      "discriminator": [
        186,
        84,
        241,
        202,
        152,
        185,
        0,
        115
      ]
    },
    {
      "name": "buybackReleased",
      "discriminator": [
        83,
        240,
        230,
        89,
        88,
        185,
        13,
        131
      ]
    },
    {
      "name": "buybackWrittenOff",
      "discriminator": [
        5,
        215,
        168,
        173,
        132,
        193,
        139,
        111
      ]
    },
    {
      "name": "tokenPriceUpdated",
      "discriminator": [
        173,
        108,
        54,
        131,
        134,
        152,
        186,
        141
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "paused",
      "msg": "Program is paused"
    },
    {
      "code": 6001,
      "name": "outOfBounds",
      "msg": "Rectangle is out of bounds or empty"
    },
    {
      "code": 6002,
      "name": "overlap",
      "msg": "Rectangle overlaps already sold blocks"
    },
    {
      "code": 6003,
      "name": "salesClosed",
      "msg": "Fixed-price sales are closed: final auction threshold reached"
    },
    {
      "code": 6004,
      "name": "invalidTitle",
      "msg": "Title too long or contains control characters"
    },
    {
      "code": 6005,
      "name": "invalidLink",
      "msg": "Link must be https:// and at most 200 bytes, no whitespace/control chars"
    },
    {
      "code": 6006,
      "name": "invalidImageUri",
      "msg": "Image URI must be ar:// or https:// and at most 200 bytes, no whitespace/control chars"
    },
    {
      "code": 6007,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6008,
      "name": "slippageExceeded",
      "msg": "Price exceeds max_lamports / max_tokens slippage guard"
    },
    {
      "code": 6009,
      "name": "stalePrice",
      "msg": "Pyth price is stale, unverified, or for the wrong feed"
    },
    {
      "code": 6010,
      "name": "invalidOraclePrice",
      "msg": "Pyth price is non-positive or has an unsupported exponent"
    },
    {
      "code": 6011,
      "name": "oracleConfidenceTooWide",
      "msg": "Pyth confidence interval too wide"
    },
    {
      "code": 6012,
      "name": "invalidPriceSource",
      "msg": "Price source account does not match config or has an unexpected layout"
    },
    {
      "code": 6013,
      "name": "curveComplete",
      "msg": "Bonding curve is complete (migrated); switch price source to the pool"
    },
    {
      "code": 6014,
      "name": "emptyReserves",
      "msg": "Reserves are zero"
    },
    {
      "code": 6015,
      "name": "crankTooSoon",
      "msg": "Token price crank called too soon"
    },
    {
      "code": 6016,
      "name": "emaUnavailable",
      "msg": "Token EMA not initialised or too old; crank the price first"
    },
    {
      "code": 6017,
      "name": "emaWarmingUp",
      "msg": "Token EMA is warming up (needs 10 cranks over >= 10 minutes after seeding)"
    },
    {
      "code": 6018,
      "name": "priceDeviationTooHigh",
      "msg": "Spot price deviates too far from the EMA; token buys paused until they converge"
    },
    {
      "code": 6019,
      "name": "emaSeedMismatch",
      "msg": "First crank after seeding: spot is outside the seed band; admin must re-seed the EMA"
    },
    {
      "code": 6020,
      "name": "tokenBuyCapExceeded",
      "msg": "Hourly limit for token-paid blocks reached; try later or pay in SOL"
    },
    {
      "code": 6021,
      "name": "unauthorized",
      "msg": "Unauthorized"
    },
    {
      "code": 6022,
      "name": "invalidParam",
      "msg": "Invalid parameter"
    },
    {
      "code": 6023,
      "name": "auctionThresholdNotReached",
      "msg": "Final auction threshold not reached"
    },
    {
      "code": 6024,
      "name": "nothingToAuction",
      "msg": "No free blocks left to auction"
    },
    {
      "code": 6025,
      "name": "auctionNotActive",
      "msg": "Auction is not active"
    },
    {
      "code": 6026,
      "name": "auctionEnded",
      "msg": "Auction has ended"
    },
    {
      "code": 6027,
      "name": "auctionNotEnded",
      "msg": "Auction has not ended yet"
    },
    {
      "code": 6028,
      "name": "bidTooLow",
      "msg": "Bid too low"
    },
    {
      "code": 6029,
      "name": "invalidPreviousBidder",
      "msg": "Previous bidder account missing or wrong"
    },
    {
      "code": 6030,
      "name": "alreadyHighestBidder",
      "msg": "Current highest bidder cannot outbid themselves"
    },
    {
      "code": 6031,
      "name": "buybackCapExceeded",
      "msg": "Buyback hourly cap exceeded"
    },
    {
      "code": 6032,
      "name": "buybackOutstanding",
      "msg": "Previous buyback release not yet recorded"
    },
    {
      "code": 6033,
      "name": "buybackAmountTooHigh",
      "msg": "Buyback amount exceeds outstanding released lamports"
    },
    {
      "code": 6034,
      "name": "buybackRateTooLow",
      "msg": "Too few tokens burned for the lamports spent"
    },
    {
      "code": 6035,
      "name": "insufficientVaultFunds",
      "msg": "Insufficient funds in buyback vault"
    }
  ],
  "types": [
    {
      "name": "ad",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u32"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "adKind"
              }
            }
          },
          {
            "name": "x",
            "type": "u8"
          },
          {
            "name": "y",
            "type": "u8"
          },
          {
            "name": "w",
            "type": "u8"
          },
          {
            "name": "h",
            "type": "u8"
          },
          {
            "name": "title",
            "type": "string"
          },
          {
            "name": "link",
            "type": "string"
          },
          {
            "name": "imageUri",
            "type": "string"
          },
          {
            "name": "imageSha256",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "payMode",
            "type": {
              "defined": {
                "name": "payMode"
              }
            }
          },
          {
            "name": "paidLamports",
            "type": "u64"
          },
          {
            "name": "paidTokens",
            "type": "u64"
          },
          {
            "name": "usdMicro",
            "type": "u64"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "updatedAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "adKind",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "rect"
          },
          {
            "name": "auctionLot"
          }
        ]
      }
    },
    {
      "name": "adPurchased",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "adId",
            "type": "u32"
          },
          {
            "name": "ad",
            "docs": [
              "Ad account address (rect: [\"ad\", y*100+x u16 LE]; auction lot: [\"ad_auction\"])."
            ],
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "x",
            "type": "u8"
          },
          {
            "name": "y",
            "type": "u8"
          },
          {
            "name": "w",
            "type": "u8"
          },
          {
            "name": "h",
            "type": "u8"
          },
          {
            "name": "payMode",
            "type": {
              "defined": {
                "name": "payMode"
              }
            }
          },
          {
            "name": "lamports",
            "type": "u64"
          },
          {
            "name": "tokensBurned",
            "type": "u64"
          },
          {
            "name": "usdMicro",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "adTransferred",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "adId",
            "type": "u32"
          },
          {
            "name": "ad",
            "type": "pubkey"
          },
          {
            "name": "from",
            "type": "pubkey"
          },
          {
            "name": "to",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "adUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "adId",
            "type": "u32"
          },
          {
            "name": "ad",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "auction",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "auctionStatus"
              }
            }
          },
          {
            "name": "startTs",
            "type": "i64"
          },
          {
            "name": "endTs",
            "type": "i64"
          },
          {
            "name": "highestBidder",
            "type": "pubkey"
          },
          {
            "name": "highestBid",
            "type": "u64"
          },
          {
            "name": "bidCount",
            "type": "u32"
          },
          {
            "name": "lotBlocks",
            "type": "u16"
          },
          {
            "name": "lotBitmap",
            "docs": [
              "Blocks in the lot (free blocks when the auction started)."
            ],
            "type": {
              "array": [
                "u8",
                1250
              ]
            }
          },
          {
            "name": "adId",
            "docs": [
              "Ad id created at settlement (valid when status == Settled)."
            ],
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "auctionBid",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "lamports",
            "type": "u64"
          },
          {
            "name": "endTs",
            "type": "i64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "auctionRestarted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "endTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "auctionResumed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "endTs",
            "type": "i64"
          },
          {
            "name": "pausedSecs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "auctionSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "winner",
            "type": "pubkey"
          },
          {
            "name": "lamports",
            "type": "u64"
          },
          {
            "name": "adId",
            "type": "u32"
          },
          {
            "name": "ad",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "auctionStarted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lotBlocks",
            "type": "u16"
          },
          {
            "name": "startTs",
            "type": "i64"
          },
          {
            "name": "endTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "auctionStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "active"
          },
          {
            "name": "settled"
          }
        ]
      }
    },
    {
      "name": "buybackBurned",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lamportsIn",
            "type": "u64"
          },
          {
            "name": "tokensBurned",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "buybackReleased",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "keeper",
            "type": "pubkey"
          },
          {
            "name": "lamports",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "buybackWrittenOff",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "keeper",
            "type": "pubkey"
          },
          {
            "name": "lamports",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "canvas",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bitmap",
            "type": {
              "array": [
                "u8",
                1250
              ]
            }
          },
          {
            "name": "soldBlocks",
            "type": "u16"
          },
          {
            "name": "nextAdId",
            "type": "u32"
          },
          {
            "name": "usdMicroRaised",
            "type": "u64"
          },
          {
            "name": "lamportsRaised",
            "type": "u64"
          },
          {
            "name": "lamportsToTreasury",
            "type": "u64"
          },
          {
            "name": "lamportsToBuyback",
            "type": "u64"
          },
          {
            "name": "tokensBurnedDirect",
            "type": "u64"
          },
          {
            "name": "tokensBurnedBuyback",
            "type": "u64"
          },
          {
            "name": "lamportsSpentBuyback",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "pendingAdmin",
            "docs": [
              "Two-step admin transfer; `Pubkey::default()` when none pending."
            ],
            "type": "pubkey"
          },
          {
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "keeper",
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "tokenProgram",
            "type": "pubkey"
          },
          {
            "name": "tokenDecimals",
            "type": "u8"
          },
          {
            "name": "pythFeedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "priceSource",
            "type": {
              "defined": {
                "name": "priceSource"
              }
            }
          },
          {
            "name": "tokenEmaPriceSol",
            "docs": [
              "lamports per token base unit * 1e18."
            ],
            "type": "u128"
          },
          {
            "name": "tokenEmaPrevPriceSol",
            "docs": [
              "EMA value before the most recent crank. Used by buys in the same slot as a crank."
            ],
            "type": "u128"
          },
          {
            "name": "tokenSlowEmaPriceSol",
            "docs": [
              "Slow EMA (4 h window), same unit; and its pre-slot value."
            ],
            "type": "u128"
          },
          {
            "name": "tokenSlowEmaPrevPriceSol",
            "type": "u128"
          },
          {
            "name": "tokenSpotPriceSol",
            "docs": [
              "Last spot read by the crank (informational)."
            ],
            "type": "u128"
          },
          {
            "name": "emaUpdatedAt",
            "type": "i64"
          },
          {
            "name": "emaUpdatedSlot",
            "type": "u64"
          },
          {
            "name": "maxPriceAgeSecs",
            "type": "u64"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "buybackCapLamportsPerHour",
            "type": "u64"
          },
          {
            "name": "buybackMaxSlippageBps",
            "type": "u16"
          },
          {
            "name": "buybackAllowanceUpdatedAt",
            "docs": [
              "Token bucket for buyback releases: refills at cap/hour, holds at most `cap`."
            ],
            "type": "i64"
          },
          {
            "name": "buybackAllowance",
            "type": "u64"
          },
          {
            "name": "buybackOutstandingLamports",
            "docs": [
              "Lamports released to the keeper that have not yet been reconciled by `record_buyback_burn`."
            ],
            "type": "u64"
          },
          {
            "name": "buybackWrittenOffLamports",
            "docs": [
              "Outstanding releases written off when the admin rotated a keeper that never reconciled (audit trail)."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "canvasBump",
            "type": "u8"
          },
          {
            "name": "buybackVaultBump",
            "type": "u8"
          },
          {
            "name": "emaWarmupCranks",
            "docs": [
              "Cranks since the EMA was (re)seeded by the admin, and the time of the first of them."
            ],
            "type": "u16"
          },
          {
            "name": "emaWarmupStartedAt",
            "type": "i64"
          },
          {
            "name": "pausedAt",
            "docs": [
              "Set when pausing; used to extend a running auction by the paused duration on unpause."
            ],
            "type": "i64"
          },
          {
            "name": "tokenBlocksCapPerHour",
            "docs": [
              "Token bucket limiting blocks bought with tokens: refills at cap/hour, holds at most cap."
            ],
            "type": "u16"
          },
          {
            "name": "tokenBlocksAllowance",
            "type": "u32"
          },
          {
            "name": "tokenBlocksAllowanceUpdatedAt",
            "type": "i64"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "initializeParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "keeper",
            "type": "pubkey"
          },
          {
            "name": "pythFeedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "priceSource",
            "type": {
              "defined": {
                "name": "priceSource"
              }
            }
          },
          {
            "name": "maxPriceAgeSecs",
            "type": "u64"
          },
          {
            "name": "buybackCapLamportsPerHour",
            "type": "u64"
          },
          {
            "name": "buybackMaxSlippageBps",
            "type": "u16"
          },
          {
            "name": "initialTokenEmaPriceSol",
            "docs": [
              "Admin-supplied EMA seed (lamports per base unit * 1e18). 0 = token pricing disabled until set_price_source."
            ],
            "type": "u128"
          },
          {
            "name": "tokenBlocksCapPerHour",
            "docs": [
              "Token-paid blocks per hour (1..=5000; default 1000)."
            ],
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "payMode",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "sol"
          },
          {
            "name": "token"
          },
          {
            "name": "auction"
          }
        ]
      }
    },
    {
      "name": "priceFeedMessage",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "feedId",
            "docs": [
              "`FeedId` but avoid the type alias because of compatibility issues with Anchor's `idl-build` feature."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "price",
            "type": "i64"
          },
          {
            "name": "conf",
            "type": "u64"
          },
          {
            "name": "exponent",
            "type": "i32"
          },
          {
            "name": "publishTime",
            "docs": [
              "The timestamp of this price update in seconds"
            ],
            "type": "i64"
          },
          {
            "name": "prevPublishTime",
            "docs": [
              "The timestamp of the previous price update. This field is intended to allow users to",
              "identify the single unique price update for any moment in time:",
              "for any time t, the unique update is the one such that prev_publish_time < t <= publish_time.",
              "",
              "Note that there may not be such an update while we are migrating to the new message-sending logic,",
              "as some price updates on pythnet may not be sent to other chains (because the message-sending",
              "logic may not have triggered). We can solve this problem by making the message-sending mandatory",
              "(which we can do once publishers have migrated over).",
              "",
              "Additionally, this field may be equal to publish_time if the message is sent on a slot where",
              "where the aggregation was unsuccesful. This problem will go away once all publishers have",
              "migrated over to a recent version of pyth-agent."
            ],
            "type": "i64"
          },
          {
            "name": "emaPrice",
            "type": "i64"
          },
          {
            "name": "emaConf",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "priceSource",
      "docs": [
        "Where the token spot price is read from."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "bondingCurve",
            "fields": [
              {
                "name": "curve",
                "type": "pubkey"
              }
            ]
          },
          {
            "name": "pool",
            "fields": [
              {
                "name": "pool",
                "type": "pubkey"
              },
              {
                "name": "baseVault",
                "type": "pubkey"
              },
              {
                "name": "quoteVault",
                "type": "pubkey"
              }
            ]
          }
        ]
      }
    },
    {
      "name": "priceUpdateV2",
      "docs": [
        "A price update account. This account is used by the Pyth Receiver program to store a verified price update from a Pyth price feed.",
        "It contains:",
        "- `write_authority`: The write authority for this account. This authority can close this account to reclaim rent or update the account to contain a different price update.",
        "- `verification_level`: The [`VerificationLevel`] of this price update. This represents how many Wormhole guardian signatures have been verified for this price update.",
        "- `price_message`: The actual price update.",
        "- `posted_slot`: The slot at which this price update was posted."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "writeAuthority",
            "type": "pubkey"
          },
          {
            "name": "verificationLevel",
            "type": {
              "defined": {
                "name": "verificationLevel"
              }
            }
          },
          {
            "name": "priceMessage",
            "type": {
              "defined": {
                "name": "priceFeedMessage"
              }
            }
          },
          {
            "name": "postedSlot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "tokenPriceUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "spot",
            "docs": [
              "lamports per token base unit * 1e18"
            ],
            "type": "u128"
          },
          {
            "name": "ema",
            "docs": [
              "lamports per token base unit * 1e18"
            ],
            "type": "u128"
          },
          {
            "name": "slowEma",
            "docs": [
              "slow (4 h) EMA, same unit"
            ],
            "type": "u128"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "verificationLevel",
      "docs": [
        "Pyth price updates are bridged to all blockchains via Wormhole.",
        "Using the price updates on another chain requires verifying the signatures of the Wormhole guardians.",
        "The usual process is to check the signatures for two thirds of the total number of guardians, but this can be cumbersome on Solana because of the transaction size limits,",
        "so we also allow for partial verification.",
        "",
        "This enum represents how much a price update has been verified:",
        "- If `Full`, we have verified the signatures for two thirds of the current guardians.",
        "- If `Partial`, only `num_signatures` guardian signatures have been checked.",
        "",
        "# Warning",
        "Using partially verified price updates is dangerous, as it lowers the threshold of guardians that need to collude to produce a malicious price update."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "partial",
            "fields": [
              {
                "name": "numSignatures",
                "type": "u8"
              }
            ]
          },
          {
            "name": "full"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "adAuctionSeed",
      "docs": [
        "The single final-auction ad: [\"ad_auction\"]."
      ],
      "type": "bytes",
      "value": "[97, 100, 95, 97, 117, 99, 116, 105, 111, 110]"
    },
    {
      "name": "adSeed",
      "docs": [
        "Rect ads: [\"ad\", top-left block index u16 LE]. Blocks are exclusive, so the address is unique per ad and",
        "independent of global state (no collisions between concurrent buyers of disjoint rects)."
      ],
      "type": "bytes",
      "value": "[97, 100]"
    },
    {
      "name": "auctionDurationSecs",
      "type": "i64",
      "value": "259200"
    },
    {
      "name": "auctionExtensionSecs",
      "docs": [
        "A bid inside the last 10 minutes pushes the end to now + 10 minutes (anti-sniping)."
      ],
      "type": "i64",
      "value": "600"
    },
    {
      "name": "auctionMinIncrementBps",
      "type": "u64",
      "value": "500"
    },
    {
      "name": "auctionMinIncrementLamports",
      "type": "u64",
      "value": "10000000"
    },
    {
      "name": "auctionMinOpeningBidLamports",
      "type": "u64",
      "value": "100000000"
    },
    {
      "name": "auctionSeed",
      "type": "bytes",
      "value": "[97, 117, 99, 116, 105, 111, 110]"
    },
    {
      "name": "auctionThresholdBlocks",
      "type": "u16",
      "value": "9900"
    },
    {
      "name": "bpsDenominator",
      "type": "u64",
      "value": "10000"
    },
    {
      "name": "buybackVaultSeed",
      "type": "bytes",
      "value": "[98, 117, 121, 98, 97, 99, 107, 95, 118, 97, 117, 108, 116]"
    },
    {
      "name": "buybackWindowSecs",
      "type": "i64",
      "value": "3600"
    },
    {
      "name": "canvasSeed",
      "type": "bytes",
      "value": "[99, 97, 110, 118, 97, 115]"
    },
    {
      "name": "configSeed",
      "type": "bytes",
      "value": "[99, 111, 110, 102, 105, 103]"
    },
    {
      "name": "defaultBuybackMaxSlippageBps",
      "type": "u16",
      "value": "1500"
    },
    {
      "name": "defaultMaxPriceAgeSecs",
      "type": "u64",
      "value": "120"
    },
    {
      "name": "defaultTokenBlocksCapPerHour",
      "docs": [
        "Hard ceiling and default for the token-payment rate limit (blocks per hour, token bucket)."
      ],
      "type": "u16",
      "value": "1000"
    },
    {
      "name": "emaAlphaBps",
      "docs": [
        "Fixed per-crank alpha = 30/600 = 5%."
      ],
      "type": "u64",
      "value": "500"
    },
    {
      "name": "emaMaxDeviationBps",
      "docs": [
        "Token buys are rejected while spot > fast EMA * (1 + 15%) (one-sided; spot below the EMA is allowed)."
      ],
      "type": "u64",
      "value": "1500"
    },
    {
      "name": "emaMinIntervalSecs",
      "type": "i64",
      "value": "30"
    },
    {
      "name": "emaSeedBandBps",
      "docs": [
        "The admin-supplied EMA seed must be within 25% of spot at the first crank after seeding."
      ],
      "type": "u64",
      "value": "2500"
    },
    {
      "name": "emaSpotClampBps",
      "docs": [
        "Spot input is clamped to EMA * (1 +/- 40%) before the alpha step, so one crank moves the EMA by at most",
        "5% * 40% = 2% (MAX_EMA_STEP_BPS), and cranks are >= 30 s apart: <= 2% per 30 s."
      ],
      "type": "u64",
      "value": "4000"
    },
    {
      "name": "emaWarmupCranks",
      "docs": [
        "Warm-up after seeding: token buys / keeper reconciliation need >= 10 cranks spanning >= 600 s."
      ],
      "type": "u16",
      "value": "10"
    },
    {
      "name": "emaWarmupSecs",
      "type": "i64",
      "value": "600"
    },
    {
      "name": "emaWindowSecs",
      "docs": [
        "Nominal EMA time constant. Each crank uses the FIXED alpha EMA_MIN_INTERVAL_SECS / EMA_WINDOW_SECS (5%),",
        "regardless of how long ago the previous crank was (a long gap never lets one crank jump to spot)."
      ],
      "type": "i64",
      "value": "600"
    },
    {
      "name": "grid",
      "docs": [
        "Blocks per side (1000 px / 10 px)."
      ],
      "type": "u16",
      "value": "100"
    },
    {
      "name": "maxBuybackSlippageBpsLimit",
      "type": "u16",
      "value": "5000"
    },
    {
      "name": "maxConfBps",
      "docs": [
        "Reject Pyth prices whose confidence interval exceeds 2% of the price."
      ],
      "type": "u64",
      "value": "200"
    },
    {
      "name": "maxEmaAgeSecs",
      "docs": [
        "`buy_with_token` refuses to price against an EMA older than this."
      ],
      "type": "i64",
      "value": "900"
    },
    {
      "name": "maxEmaStepBps",
      "type": "u64",
      "value": "200"
    },
    {
      "name": "maxPriceAgeLimitSecs",
      "docs": [
        "Upper bound the admin can configure for the Pyth staleness window."
      ],
      "type": "u64",
      "value": "300"
    },
    {
      "name": "maxTokenBlocksCapPerHour",
      "type": "u16",
      "value": "5000"
    },
    {
      "name": "pricePerBlockUsdMicro",
      "docs": [
        "$100 per 10x10 block, micro-USD (6 decimals)."
      ],
      "type": "u64",
      "value": "100000000"
    },
    {
      "name": "slowEmaWindowSecs",
      "docs": [
        "Slow EMA (audit round 2, ratchet fix): 4-hour window, alpha = 30 s / 14_400 s = 1/480 per crank, same ±40% clamp,",
        "so it moves at most 0.0833% per crank (~ +10.5% per hour of a held +40% pump). Token price = min(spot, fast, slow)."
      ],
      "type": "i64",
      "value": "14400"
    },
    {
      "name": "tokenDiscountBps",
      "docs": [
        "Discount for paying in the token."
      ],
      "type": "u64",
      "value": "1000"
    },
    {
      "name": "tokenSymbol",
      "docs": [
        "Ticker placeholder. The only place in the program that names the token."
      ],
      "type": "string",
      "value": "\"PIXEL\""
    },
    {
      "name": "totalBlocks",
      "type": "u16",
      "value": "10000"
    },
    {
      "name": "treasuryBps",
      "docs": [
        "Share of SOL payments sent to the treasury. The remainder (incl. rounding dust) goes to the buyback vault."
      ],
      "type": "u64",
      "value": "5000"
    }
  ]
};
