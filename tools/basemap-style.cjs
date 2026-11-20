const b = require('@protomaps/basemaps');
const light = Object.assign({}, b.namedFlavor('light'), {
  background: '#efede7', earth: '#efede7',
  park_a: '#e2e8da', park_b: '#dde5d4', wood_a: '#e2e8da', wood_b: '#dbe3d2', scrub_a: '#e6e9de', scrub_b: '#e3e7da',
  hospital: '#ece8e2', industrial: '#ebe8e1', school: '#ece8e1', pedestrian: '#f2f0ea', aerodrome: '#e9e6df', zoo: '#e4e8dc', military: '#e9e6df',
  glacier: '#f4f4f2', sand: '#ece7da', beach: '#ece7da', runway: '#e0ddd5',
  water: '#c5d6e2', buildings: '#e2ded5', pier: '#e2ded5',
  other: '#f7f5f0', minor_service: '#f7f5f0', minor_a: '#fbfaf7', minor_b: '#fbfaf7', link: '#ffffff', major: '#ffffff', highway: '#ffffff',
  minor_service_casing: '#e2ded5', minor_casing: '#e2ded5', link_casing: '#d9d4c9', major_casing_late: '#d9d4c9', highway_casing_late: '#cfc9bc', major_casing_early: '#d9d4c9', highway_casing_early: '#cfc9bc',
  railway: '#c9c4b8', boundaries: '#b9b3a6',
  roads_label_minor: '#8c8a84', roads_label_major: '#7a7872', city_label: '#4a4d52', subplace_label: '#7a7872', state_label: '#9a978f',
});
const dark = Object.assign({}, b.namedFlavor('dark'), {});
const out = {};
for (const [name, f] of [['light', light], ['dark', dark]]) {
  let layers = b.layers('protomaps', f, { lang: 'en' });
  layers = layers.filter(l => !['pois', 'roads_shields', 'roads_oneway', 'address_label'].includes(l.id));
  for (const l of layers) if (l.layout) delete l.layout['icon-image'];
  out[name] = layers;
}
console.log(JSON.stringify(out));
