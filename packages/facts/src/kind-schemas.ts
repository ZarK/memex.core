// Made by scripts/kind-schemas.mjs from schemas/user/ and schemas/contacts/. Do not edit.
export const KIND_SCHEMAS: Record<string, unknown> = {
 "schemas/user/chapter.json": {
  "type": "object",
  "required": [
   "title",
   "type",
   "from"
  ],
  "properties": {
   "title": {
    "$ref": "common.json#/$defs/text"
   },
   "type": {
    "enum": [
     "trip",
     "move",
     "project",
     "payoff",
     "period",
     "other"
    ]
   },
   "from": {
    "$ref": "common.json#/$defs/partialDate"
   },
   "to": {
    "$ref": "common.json#/$defs/partialDate"
   },
   "trip": {
    "$ref": "common.json#/$defs/tripId"
   }
  },
  "additionalProperties": false
 },
 "schemas/user/common.json": {
  "$defs": {
   "kind": {
    "enum": [
     "person",
     "home",
     "workplace",
     "place",
     "stay",
     "trip",
     "chapter",
     "milestone"
    ]
   },
   "recordId": {
    "type": "string",
    "pattern": "^(person|home|workplace|place|stay|trip|chapter|milestone)_[0-9a-f]{32}$"
   },
   "personId": {
    "type": "string",
    "pattern": "^person_[0-9a-f]{32}$"
   },
   "homeId": {
    "type": "string",
    "pattern": "^home_[0-9a-f]{32}$"
   },
   "tripId": {
    "type": "string",
    "pattern": "^trip_[0-9a-f]{32}$"
   },
   "placeLikeId": {
    "type": "string",
    "pattern": "^(home|workplace|place)_[0-9a-f]{32}$"
   },
   "correctionId": {
    "type": "string",
    "pattern": "^cor_[0-9a-f]{32}$"
   },
   "changeId": {
    "type": "string",
    "pattern": "^chg_[0-9a-f]{32}$"
   },
   "appId": {
    "type": "string",
    "pattern": "^[a-z][a-z0-9]*$"
   },
   "scope": {
    "type": "string",
    "pattern": "^[a-z][a-z0-9]*\\.(persons|homes|workplaces|places|stays|trips|chapters|milestones)$"
   },
   "partition": {
    "type": "string",
    "minLength": 1,
    "maxLength": 64
   },
   "claimKey": {
    "type": "string",
    "minLength": 1,
    "maxLength": 200
   },
   "ref": {
    "type": "object",
    "required": [
     "app",
     "kind",
     "id"
    ],
    "properties": {
     "app": {
      "$ref": "common.json#/$defs/appId"
     },
     "kind": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]*$"
     },
     "id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
     }
    },
    "additionalProperties": false
   },
   "contactRef": {
    "type": "object",
    "required": [
     "app",
     "kind",
     "id"
    ],
    "properties": {
     "app": {
      "const": "contacts"
     },
     "kind": {
      "const": "person"
     },
     "id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
     }
    },
    "additionalProperties": false
   },
   "personRef": {
    "oneOf": [
     {
      "$ref": "common.json#/$defs/personId"
     },
     {
      "$ref": "common.json#/$defs/contactRef"
     }
    ]
   },
   "location": {
    "type": "object",
    "required": [
     "lat",
     "lon"
    ],
    "properties": {
     "lat": {
      "type": "number",
      "minimum": -90,
      "maximum": 90
     },
     "lon": {
      "type": "number",
      "minimum": -180,
      "maximum": 180
     },
     "radiusM": {
      "type": "number",
      "exclusiveMinimum": 0
     }
    },
    "additionalProperties": false
   },
   "country": {
    "type": "string",
    "pattern": "^[A-Z]{2}$"
   },
   "localDate": {
    "type": "string",
    "pattern": "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$"
   },
   "partialDate": {
    "type": "string",
    "pattern": "^[0-9]{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?)?$"
   },
   "utcTime": {
    "type": "string",
    "format": "date-time",
    "pattern": "Z$"
   },
   "confidence": {
    "type": "number",
    "minimum": 0,
    "maximum": 1
   },
   "text": {
    "type": "string",
    "minLength": 1,
    "maxLength": 500
   },
   "kindFields": {
    "allOf": [
     {
      "if": {
       "properties": {
        "kind": {
         "const": "person"
        }
       },
       "required": [
        "kind"
       ]
      },
      "then": {
       "properties": {
        "fields": {
         "$ref": "person.json"
        }
       }
      }
     },
     {
      "if": {
       "properties": {
        "kind": {
         "const": "home"
        }
       },
       "required": [
        "kind"
       ]
      },
      "then": {
       "properties": {
        "fields": {
         "$ref": "home.json"
        }
       }
      }
     },
     {
      "if": {
       "properties": {
        "kind": {
         "const": "workplace"
        }
       },
       "required": [
        "kind"
       ]
      },
      "then": {
       "properties": {
        "fields": {
         "$ref": "workplace.json"
        }
       }
      }
     },
     {
      "if": {
       "properties": {
        "kind": {
         "const": "place"
        }
       },
       "required": [
        "kind"
       ]
      },
      "then": {
       "properties": {
        "fields": {
         "$ref": "place.json"
        }
       }
      }
     },
     {
      "if": {
       "properties": {
        "kind": {
         "const": "stay"
        }
       },
       "required": [
        "kind"
       ]
      },
      "then": {
       "properties": {
        "fields": {
         "$ref": "stay.json"
        }
       }
      }
     },
     {
      "if": {
       "properties": {
        "kind": {
         "const": "trip"
        }
       },
       "required": [
        "kind"
       ]
      },
      "then": {
       "properties": {
        "fields": {
         "$ref": "trip.json"
        }
       }
      }
     },
     {
      "if": {
       "properties": {
        "kind": {
         "const": "chapter"
        }
       },
       "required": [
        "kind"
       ]
      },
      "then": {
       "properties": {
        "fields": {
         "$ref": "chapter.json"
        }
       }
      }
     },
     {
      "if": {
       "properties": {
        "kind": {
         "const": "milestone"
        }
       },
       "required": [
        "kind"
       ]
      },
      "then": {
       "properties": {
        "fields": {
         "$ref": "milestone.json"
        }
       }
      }
     }
    ]
   }
  }
 },
 "schemas/user/home.json": {
  "type": "object",
  "required": [
   "type"
  ],
  "properties": {
   "type": {
    "enum": [
     "home",
     "cabin"
    ]
   },
   "label": {
    "$ref": "common.json#/$defs/text"
   },
   "location": {
    "$ref": "common.json#/$defs/location"
   },
   "address": {
    "$ref": "common.json#/$defs/text"
   },
   "town": {
    "$ref": "common.json#/$defs/text"
   },
   "country": {
    "$ref": "common.json#/$defs/country"
   },
   "from": {
    "$ref": "common.json#/$defs/partialDate"
   },
   "to": {
    "$ref": "common.json#/$defs/partialDate"
   },
   "members": {
    "type": "array",
    "items": {
     "type": "object",
     "required": [
      "person"
     ],
     "properties": {
      "person": {
       "$ref": "common.json#/$defs/personRef"
      },
      "from": {
       "$ref": "common.json#/$defs/partialDate"
      },
      "to": {
       "$ref": "common.json#/$defs/partialDate"
      },
      "child": {
       "type": "boolean"
      }
     },
     "additionalProperties": false
    }
   }
  },
  "additionalProperties": false
 },
 "schemas/user/milestone.json": {
  "type": "object",
  "required": [
   "title",
   "date"
  ],
  "properties": {
   "title": {
    "$ref": "common.json#/$defs/text"
   },
   "date": {
    "$ref": "common.json#/$defs/partialDate"
   },
   "persons": {
    "type": "array",
    "items": {
     "$ref": "common.json#/$defs/personRef"
    }
   }
  },
  "additionalProperties": false
 },
 "schemas/user/person.json": {
  "type": "object",
  "required": [
   "name",
   "role"
  ],
  "properties": {
   "name": {
    "$ref": "common.json#/$defs/text"
   },
   "role": {
    "const": "owner"
   },
   "contact": {
    "$ref": "common.json#/$defs/contactRef"
   }
  },
  "additionalProperties": false
 },
 "schemas/user/place.json": {
  "type": "object",
  "required": [
   "name",
   "type",
   "location"
  ],
  "properties": {
   "name": {
    "$ref": "common.json#/$defs/text"
   },
   "type": {
    "enum": [
     "bar",
     "restaurant",
     "cafe",
     "shop",
     "sport",
     "culture",
     "hotel",
     "area",
     "spot",
     "other"
    ]
   },
   "location": {
    "$ref": "common.json#/$defs/location"
   },
   "address": {
    "$ref": "common.json#/$defs/text"
   },
   "town": {
    "$ref": "common.json#/$defs/text"
   },
   "country": {
    "$ref": "common.json#/$defs/country"
   }
  },
  "additionalProperties": false
 },
 "schemas/user/stay.json": {
  "type": "object",
  "required": [
   "arrival",
   "departure",
   "location"
  ],
  "properties": {
   "arrival": {
    "$ref": "common.json#/$defs/utcTime"
   },
   "departure": {
    "$ref": "common.json#/$defs/utcTime"
   },
   "location": {
    "$ref": "common.json#/$defs/location"
   },
   "name": {
    "$ref": "common.json#/$defs/text"
   },
   "place": {
    "$ref": "common.json#/$defs/placeLikeId"
   },
   "timeZone": {
    "type": "string",
    "minLength": 1,
    "maxLength": 64
   }
  },
  "additionalProperties": false
 },
 "schemas/user/trip.json": {
  "type": "object",
  "required": [
   "title",
   "firstDay",
   "lastDay"
  ],
  "properties": {
   "title": {
    "$ref": "common.json#/$defs/text"
   },
   "firstDay": {
    "$ref": "common.json#/$defs/localDate"
   },
   "lastDay": {
    "$ref": "common.json#/$defs/localDate"
   },
   "destinations": {
    "type": "array",
    "items": {
     "type": "object",
     "required": [
      "name"
     ],
     "properties": {
      "name": {
       "$ref": "common.json#/$defs/text"
      },
      "town": {
       "$ref": "common.json#/$defs/text"
      },
      "country": {
       "$ref": "common.json#/$defs/country"
      },
      "location": {
       "$ref": "common.json#/$defs/location"
      }
     },
     "additionalProperties": false
    }
   },
   "countries": {
    "type": "array",
    "items": {
     "$ref": "common.json#/$defs/country"
    },
    "uniqueItems": true
   },
   "participants": {
    "type": "array",
    "items": {
     "$ref": "common.json#/$defs/personRef"
    }
   },
   "home": {
    "$ref": "common.json#/$defs/homeId"
   }
  },
  "additionalProperties": false
 },
 "schemas/user/workplace.json": {
  "type": "object",
  "required": [
   "name",
   "type"
  ],
  "properties": {
   "name": {
    "$ref": "common.json#/$defs/text"
   },
   "type": {
    "enum": [
     "employer",
     "client",
     "own",
     "school"
    ]
   },
   "sites": {
    "type": "array",
    "items": {
     "type": "object",
     "required": [
      "location"
     ],
     "properties": {
      "location": {
       "$ref": "common.json#/$defs/location"
      },
      "label": {
       "$ref": "common.json#/$defs/text"
      },
      "type": {
       "enum": [
        "office",
        "cabin",
        "other"
       ]
      }
     },
     "additionalProperties": false
    }
   },
   "stints": {
    "type": "array",
    "items": {
     "type": "object",
     "minProperties": 1,
     "properties": {
      "from": {
       "$ref": "common.json#/$defs/partialDate"
      },
      "to": {
       "$ref": "common.json#/$defs/partialDate"
      }
     },
     "additionalProperties": false
    }
   }
  },
  "additionalProperties": false
 },
 "schemas/contacts/circle.json": {
  "type": "object",
  "required": [
   "name"
  ],
  "properties": {
   "name": {
    "$ref": "../user/common.json#/$defs/text"
   },
   "from": {
    "$ref": "../user/common.json#/$defs/partialDate"
   },
   "to": {
    "$ref": "../user/common.json#/$defs/partialDate"
   }
  },
  "additionalProperties": false
 },
 "schemas/contacts/common.json": {
  "$defs": {
   "kind": {
    "enum": [
     "person",
     "home",
     "workplace",
     "circle",
     "relation",
     "date",
     "identity"
    ]
   },
   "factKind": {
    "enum": [
     "person",
     "home",
     "workplace",
     "circle",
     "relation",
     "date",
     "identity"
    ]
   },
   "recordId": {
    "type": "string",
    "pattern": "^(person|home|workplace|circle|relation|date|identity)_[0-9a-f]{32}$"
   },
   "personId": {
    "type": "string",
    "pattern": "^person_[0-9a-f]{32}$"
   },
   "cardId": {
    "type": "string",
    "pattern": "^card_[0-9a-f]{32}$"
   },
   "scope": {
    "type": "string",
    "pattern": "^[a-z][a-z0-9]*\\.(persons|homes|workplaces|circles|relations|dates|identities)$"
   },
   "handle": {
    "type": "string",
    "minLength": 3,
    "maxLength": 320,
    "pattern": "^(\\+[1-9][0-9]{6,14}|[^@\\s]+@[^@\\s]+|[a-z][a-z0-9]*:\\S+)$"
   },
   "subject": {
    "oneOf": [
     {
      "type": "object",
      "required": [
       "person"
      ],
      "properties": {
       "person": {
        "$ref": "#/$defs/personId"
       }
      },
      "additionalProperties": false
     },
     {
      "type": "object",
      "required": [
       "card"
      ],
      "properties": {
       "card": {
        "$ref": "#/$defs/cardId"
       }
      },
      "additionalProperties": false
     },
     {
      "type": "object",
      "required": [
       "handle",
       "at"
      ],
      "properties": {
       "handle": {
        "$ref": "#/$defs/handle"
       },
       "at": {
        "$ref": "../user/common.json#/$defs/utcTime"
       }
      },
      "additionalProperties": false
     }
    ]
   },
   "resident": {
    "type": "object",
    "required": [
     "person"
    ],
    "properties": {
     "person": {
      "$ref": "#/$defs/personId"
     },
     "from": {
      "$ref": "../user/common.json#/$defs/partialDate"
     },
     "to": {
      "$ref": "../user/common.json#/$defs/partialDate"
     },
     "child": {
      "type": "boolean"
     }
    },
    "additionalProperties": false
   },
   "kindFields": {
    "allOf": [
     {
      "if": {
       "properties": {
        "kind": {
         "const": "person"
        }
       },
       "required": [
        "kind"
       ]
      },
      "then": {
       "properties": {
        "fields": {
         "$ref": "person.json"
        }
       }
      }
     },
     {
      "if": {
       "properties": {
        "kind": {
         "const": "home"
        }
       },
       "required": [
        "kind"
       ]
      },
      "then": {
       "properties": {
        "fields": {
         "$ref": "home.json"
        }
       }
      }
     },
     {
      "if": {
       "properties": {
        "kind": {
         "const": "workplace"
        }
       },
       "required": [
        "kind"
       ]
      },
      "then": {
       "properties": {
        "fields": {
         "$ref": "workplace.json"
        }
       }
      }
     },
     {
      "if": {
       "properties": {
        "kind": {
         "const": "circle"
        }
       },
       "required": [
        "kind"
       ]
      },
      "then": {
       "properties": {
        "fields": {
         "$ref": "circle.json"
        }
       }
      }
     },
     {
      "if": {
       "properties": {
        "kind": {
         "const": "relation"
        }
       },
       "required": [
        "kind"
       ]
      },
      "then": {
       "properties": {
        "fields": {
         "$ref": "relation.json"
        }
       }
      }
     },
     {
      "if": {
       "properties": {
        "kind": {
         "const": "date"
        }
       },
       "required": [
        "kind"
       ]
      },
      "then": {
       "properties": {
        "fields": {
         "$ref": "date.json"
        }
       }
      }
     },
     {
      "if": {
       "properties": {
        "kind": {
         "const": "identity"
        }
       },
       "required": [
        "kind"
       ]
      },
      "then": {
       "properties": {
        "fields": {
         "$ref": "identity.json"
        }
       }
      }
     }
    ]
   }
  }
 },
 "schemas/contacts/date.json": {
  "type": "object",
  "required": [
   "type",
   "date"
  ],
  "properties": {
   "type": {
    "enum": [
     "birthday",
     "anniversary",
     "memorial",
     "firstMet",
     "other"
    ]
   },
   "date": {
    "type": "string",
    "pattern": "^([0-9]{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?)?|--(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01]))$"
   },
   "label": {
    "$ref": "../user/common.json#/$defs/text"
   }
  },
  "additionalProperties": false
 },
 "schemas/contacts/home.json": {
  "type": "object",
  "anyOf": [
   {
    "required": [
     "address"
    ]
   },
   {
    "required": [
     "town"
    ]
   },
   {
    "required": [
     "location"
    ]
   }
  ],
  "properties": {
   "type": {
    "enum": [
     "home",
     "cabin"
    ]
   },
   "label": {
    "$ref": "../user/common.json#/$defs/text"
   },
   "location": {
    "$ref": "../user/common.json#/$defs/location"
   },
   "address": {
    "$ref": "../user/common.json#/$defs/text"
   },
   "town": {
    "$ref": "../user/common.json#/$defs/text"
   },
   "country": {
    "$ref": "../user/common.json#/$defs/country"
   },
   "from": {
    "$ref": "../user/common.json#/$defs/partialDate"
   },
   "to": {
    "$ref": "../user/common.json#/$defs/partialDate"
   },
   "residents": {
    "type": "array",
    "items": {
     "$ref": "common.json#/$defs/resident"
    }
   }
  },
  "additionalProperties": false
 },
 "schemas/contacts/identity.json": {
  "type": "object",
  "required": [
   "type",
   "value"
  ],
  "properties": {
   "type": {
    "enum": [
     "email",
     "phone",
     "handle"
    ]
   },
   "value": {
    "$ref": "common.json#/$defs/handle"
   },
   "service": {
    "type": "string",
    "pattern": "^[a-z][a-z0-9]*$"
   },
   "label": {
    "$ref": "../user/common.json#/$defs/text"
   },
   "from": {
    "$ref": "../user/common.json#/$defs/partialDate"
   },
   "to": {
    "$ref": "../user/common.json#/$defs/partialDate"
   },
   "shared": {
    "type": "boolean"
   }
  },
  "additionalProperties": false
 },
 "schemas/contacts/person.json": {
  "type": "object",
  "required": [
   "name"
  ],
  "properties": {
   "name": {
    "$ref": "../user/common.json#/$defs/text"
   },
   "otherNames": {
    "type": "array",
    "items": {
     "$ref": "../user/common.json#/$defs/text"
    },
    "uniqueItems": true
   },
   "type": {
    "enum": [
     "person",
     "organization",
     "unknown"
    ]
   }
  },
  "additionalProperties": false
 },
 "schemas/contacts/relation.json": {
  "type": "object",
  "required": [
   "type"
  ],
  "properties": {
   "type": {
    "enum": [
     "partner",
     "parent",
     "child",
     "sibling",
     "family",
     "friend",
     "colleague",
     "other"
    ]
   },
   "label": {
    "$ref": "../user/common.json#/$defs/text"
   },
   "from": {
    "$ref": "../user/common.json#/$defs/partialDate"
   },
   "to": {
    "$ref": "../user/common.json#/$defs/partialDate"
   }
  },
  "additionalProperties": false
 },
 "schemas/contacts/workplace.json": {
  "type": "object",
  "required": [
   "name"
  ],
  "properties": {
   "name": {
    "$ref": "../user/common.json#/$defs/text"
   },
   "type": {
    "enum": [
     "employer",
     "client",
     "own",
     "school"
    ]
   },
   "sites": {
    "type": "array",
    "items": {
     "type": "object",
     "required": [
      "location"
     ],
     "properties": {
      "location": {
       "$ref": "../user/common.json#/$defs/location"
      },
      "label": {
       "$ref": "../user/common.json#/$defs/text"
      },
      "type": {
       "enum": [
        "office",
        "cabin",
        "other"
       ]
      }
     },
     "additionalProperties": false
    }
   },
   "stints": {
    "type": "array",
    "items": {
     "type": "object",
     "minProperties": 1,
     "properties": {
      "from": {
       "$ref": "../user/common.json#/$defs/partialDate"
      },
      "to": {
       "$ref": "../user/common.json#/$defs/partialDate"
      },
      "title": {
       "$ref": "../user/common.json#/$defs/text"
      }
     },
     "additionalProperties": false
    }
   }
  },
  "additionalProperties": false
 }
};
