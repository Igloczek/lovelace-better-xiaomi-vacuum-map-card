### Checklist

- [X] I have updated to the latest available card version.
- [X] I have cleared the browser cache.
- [X] This issue has not been reported yet.

### The problem

The map image doesn't load, I only see an empty card with the buttons. Calibration seems fine.

### Which card build do you run?

Release

### What version of the card has described problem?

1.10.0

### What was the last working version card?

1.9.2

### What vacuum model do you have problems with?

Xiaomi S5

### Which integration do you use to control your vacuum (link)?

https://github.com/PiotrMachowski/Home-Assistant-custom-components-Xiaomi-Cloud-Map-Extractor

### What browser (browsers/apps) does have this problem?

Firefox 140

### What version of Home Assistant do you use?

2026.11.1

### What type of installation are you running?

Home Assistant Container

### Card's configuration

```yaml
type: custom:better-xiaomi-vacuum-map-card
entity: vacuum.xiaomi_s5
map_source:
  image: http://192.168.1.20:8123/api/camera_proxy/camera.xiaomi_cloud_map_extractor
  headers:
    Authorization: Bearer {{FAKE_TOKEN}}
calibration_source:
  camera: true
```

### Javascript errors shown in the browser's console (if applicable)

```shell
GET http://192.168.1.20:8123/api/camera_proxy/camera.xiaomi_cloud_map_extractor 401 (Unauthorized)
```

### Additional information

_No response_
