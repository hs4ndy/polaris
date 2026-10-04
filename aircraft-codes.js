/* ICAO Doc 8643 aircraft type designators, checked 2026-10-04.
 * Sources: https://www.icao.int/operational-safety/doc-8643-aircraft-type-designators/search
 * https://doc8643.icao.int/External/AircraftTypes (official search data)
 * Fleet: https://infiniteflight.com/fleet and Polaris /meta/liveries.
 * E175 variant: https://infiniteflight.com/fleet/e175 explicitly identifies E75L.
 * Aliases cover both the fleet website and Live API names. Unknown models are
 * deliberately not assigned a guessed ICAO code.
 */
(function (root) {
  const groups = [
    ['BCS3', 'A220-300'],
    ['A318', 'A318', 'A318-100'],
    ['A319', 'A319', 'A319-100'],
    ['A320', 'A320', 'A320-200'],
    ['A321', 'A321', 'A321-200'],
    ['A21N', 'A321neo', 'A321 NEO', 'A321NX'],
    ['A332', 'A330-200', 'A330-200F'],
    ['A333', 'A330-300'],
    ['A338', 'A330-800', 'A330-800neo'],
    ['A339', 'A330-900', 'A330-900neo'],
    ['A346', 'A340-600'],
    ['A359', 'A350-900'],
    ['A35K', 'A350-1000'],
    ['A388', 'A380', 'A380-800'],
    ['B712', '717-200'],
    ['B737', '737-700', '737-700-BBJ', '737-700 BBJ'],
    ['B738', '737-800'],
    ['B739', '737-900', '737-900ER'],
    ['B38M', '737 MAX 8', '737-8 MAX', '737 MAX-8', '737-8'],
    ['B742', '747-200'],
    ['B744', '747-400'],
    ['B748', '747-8', '747-8i'],
    ['B752', '757-200'],
    ['B763', '767-300', '767-300ER'],
    ['B772', '777-200ER'],
    ['B77L', '777-200LR', '777F', '777-F'],
    ['B77W', '777-300ER'],
    ['B788', '787-8'],
    ['B789', '787-9'],
    ['B78X', '787-10'],
    ['CL35', 'Challenger 350', 'BD-100 Challenger 350'],
    ['CRJ2', 'CRJ-200'],
    ['CRJ7', 'CRJ-700'],
    ['CRJ9', 'CRJ-900'],
    ['CRJX', 'CRJ-1000'],
    ['DH8D', 'Dash 8-Q400', 'Dash-8 Q400', 'Dash 8 Q400', 'Q400'],
    ['C172', '172', '172 Skyhawk'],
    ['C208', '208', '208 Caravan'],
    ['CC19', 'XCub', 'CC-19 XCub'],
    ['TBM9', 'TBM-930'],
    ['E75L', 'E175', '175 (long wing)'],
    ['E75S', '175 (short wing)', 'E175 short wing'],
    ['E190', 'E190'],
    ['A10', 'A-10', 'A-10 Thunderbolt II', 'A-10 Thunderbolt 2'],
    ['C130', 'C-130H'],
    ['C30J', 'C-130J', 'C-130J-30'],
    ['C17', 'C-17', 'C-17 Globemaster III'],
    ['DC10', 'DC-10', 'DC-10F'],
    ['MD11', 'MD-11', 'MD-11F'],
    ['P28A', 'PA28 Archer', 'PA-28 Archer'],
    ['SR22', 'SR22 GTS', 'SR22'],
    ['F14', 'F-14', 'F-14 Tomcat'],
    ['F16', 'F-16', 'F-16 Fighting Falcon'],
    ['F22', 'F-22', 'F-22 Raptor'],
    ['F18S', 'F/A-18E Super Hornet', 'FA-18E Super Hornet'],
    ['P38', 'P-38', 'P-38 Lightning'],
    ['SPIT', 'Spitfire'],
  ];
  function normalize(name) {
    return String(name || '').trim().toUpperCase()
      .replace(/^(?:AIRBUS|BOEING|BOMBARDIER|CESSNA|CUBCRAFTERS|DAHER|EMBRAER|FAIRCHILD REPUBLIC|LOCKHEED(?: MARTIN)?|MCDONNELL DOUGLAS|PIPER|CIRRUS|SUPERMARINE)\s+/, '')
      .replace(/[^A-Z0-9]/g, '');
  }
  const codes = new Map();
  for (const [code, ...aliases] of groups) {
    codes.set(code, code);
    for (const alias of aliases) codes.set(normalize(alias), code);
  }
  function aircraftChip(name) {
    return codes.get(normalize(name)) || '';
  }
  if (typeof module === 'object' && module.exports) module.exports = { aircraftChip, groups };
  else root.aircraftChip = aircraftChip;
})(typeof globalThis !== 'undefined' ? globalThis : this);
