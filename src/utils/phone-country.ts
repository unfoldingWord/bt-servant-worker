/**
 * Derive an end-user country from a phone-number user id (E.164 calling code).
 *
 * WHY THIS EXISTS: `request.cf.country` records where the HTTP request entered
 * Cloudflare's edge. For gateway-relayed clients (WhatsApp, Telegram, Signal)
 * that is the GATEWAY's deployment country, not the user's — every WhatsApp
 * user in the world collapses into wherever Meta's webhook egress lands. The
 * messaging platforms, however, key users by their verified phone number, and
 * that number's calling code is a real, platform-authenticated signal of where
 * the user actually is.
 *
 * The output set is bounded BY CONSTRUCTION: every return value is a literal
 * from the table below (ISO 3166-1 alpha-2), so this is safe to use as a metric
 * label without a separate value allow-list. Unrecognized or non-phone ids
 * (web/email users, test identities) return `undefined` rather than a guess.
 *
 * Pure and synchronous: no I/O, no allocation beyond a digit strip. Cannot
 * throw for any string input.
 */

/**
 * Canadian NANP area codes. `+1` is shared across the North American Numbering
 * Plan, so a bare `1` prefix cannot distinguish US from Canada; the area code
 * can. Caribbean NANP members (`1242` Bahamas, `1876` Jamaica, …) are handled
 * as ordinary longer prefixes in the main table.
 */
const CANADA_AREA_CODES: ReadonlySet<string> = new Set([
  '204',
  '226',
  '236',
  '249',
  '250',
  '263',
  '289',
  '306',
  '343',
  '354',
  '365',
  '367',
  '368',
  '382',
  '387',
  '403',
  '416',
  '418',
  '428',
  '431',
  '437',
  '438',
  '450',
  '468',
  '474',
  '506',
  '514',
  '519',
  '548',
  '579',
  '581',
  '584',
  '587',
  '600',
  '604',
  '613',
  '639',
  '647',
  '672',
  '683',
  '705',
  '709',
  '742',
  '753',
  '778',
  '780',
  '782',
  '807',
  '819',
  '825',
  '867',
  '873',
  '879',
  '902',
  '905',
]);

/**
 * E.164 calling code → ISO 3166-1 alpha-2, sorted longest-prefix-first at
 * module load so the first match wins (e.g. `670` Timor-Leste must be tested
 * before `6`-prefixed neighbours, `1876` Jamaica before bare `1`).
 */
const CALLING_CODES: ReadonlyArray<readonly [string, string]> = (
  [
    // North America / Caribbean (NANP long prefixes before bare '1')
    ['1242', 'BS'],
    ['1246', 'BB'],
    ['1264', 'AI'],
    ['1268', 'AG'],
    ['1284', 'VG'],
    ['1340', 'VI'],
    ['1345', 'KY'],
    ['1441', 'BM'],
    ['1473', 'GD'],
    ['1649', 'TC'],
    ['1664', 'MS'],
    ['1670', 'MP'],
    ['1671', 'GU'],
    ['1684', 'AS'],
    ['1721', 'SX'],
    ['1758', 'LC'],
    ['1767', 'DM'],
    ['1784', 'VC'],
    ['1809', 'DO'],
    ['1829', 'DO'],
    ['1849', 'DO'],
    ['1868', 'TT'],
    ['1869', 'KN'],
    ['1876', 'JM'],
    ['1939', 'PR'],
    ['1787', 'PR'],
    // Africa
    ['20', 'EG'],
    ['211', 'SS'],
    ['212', 'MA'],
    ['213', 'DZ'],
    ['216', 'TN'],
    ['218', 'LY'],
    ['220', 'GM'],
    ['221', 'SN'],
    ['222', 'MR'],
    ['223', 'ML'],
    ['224', 'GN'],
    ['225', 'CI'],
    ['226', 'BF'],
    ['227', 'NE'],
    ['228', 'TG'],
    ['229', 'BJ'],
    ['230', 'MU'],
    ['231', 'LR'],
    ['232', 'SL'],
    ['233', 'GH'],
    ['234', 'NG'],
    ['235', 'TD'],
    ['236', 'CF'],
    ['237', 'CM'],
    ['238', 'CV'],
    ['239', 'ST'],
    ['240', 'GQ'],
    ['241', 'GA'],
    ['242', 'CG'],
    ['243', 'CD'],
    ['244', 'AO'],
    ['245', 'GW'],
    ['246', 'IO'],
    ['248', 'SC'],
    ['249', 'SD'],
    ['250', 'RW'],
    ['251', 'ET'],
    ['252', 'SO'],
    ['253', 'DJ'],
    ['254', 'KE'],
    ['255', 'TZ'],
    ['256', 'UG'],
    ['257', 'BI'],
    ['258', 'MZ'],
    ['260', 'ZM'],
    ['261', 'MG'],
    ['262', 'RE'],
    ['263', 'ZW'],
    ['264', 'NA'],
    ['265', 'MW'],
    ['266', 'LS'],
    ['267', 'BW'],
    ['268', 'SZ'],
    ['269', 'KM'],
    ['27', 'ZA'],
    ['290', 'SH'],
    ['291', 'ER'],
    ['297', 'AW'],
    ['298', 'FO'],
    ['299', 'GL'],
    // Europe
    ['30', 'GR'],
    ['31', 'NL'],
    ['32', 'BE'],
    ['33', 'FR'],
    ['34', 'ES'],
    ['350', 'GI'],
    ['351', 'PT'],
    ['352', 'LU'],
    ['353', 'IE'],
    ['354', 'IS'],
    ['355', 'AL'],
    ['356', 'MT'],
    ['357', 'CY'],
    ['358', 'FI'],
    ['359', 'BG'],
    ['36', 'HU'],
    ['370', 'LT'],
    ['371', 'LV'],
    ['372', 'EE'],
    ['373', 'MD'],
    ['374', 'AM'],
    ['375', 'BY'],
    ['376', 'AD'],
    ['377', 'MC'],
    ['378', 'SM'],
    ['380', 'UA'],
    ['381', 'RS'],
    ['382', 'ME'],
    ['383', 'XK'],
    ['385', 'HR'],
    ['386', 'SI'],
    ['387', 'BA'],
    ['389', 'MK'],
    ['39', 'IT'],
    ['40', 'RO'],
    ['41', 'CH'],
    ['420', 'CZ'],
    ['421', 'SK'],
    ['423', 'LI'],
    ['43', 'AT'],
    ['44', 'GB'],
    ['45', 'DK'],
    ['46', 'SE'],
    ['47', 'NO'],
    ['48', 'PL'],
    ['49', 'DE'],
    // Latin America
    ['500', 'FK'],
    ['501', 'BZ'],
    ['502', 'GT'],
    ['503', 'SV'],
    ['504', 'HN'],
    ['505', 'NI'],
    ['506', 'CR'],
    ['507', 'PA'],
    ['508', 'PM'],
    ['509', 'HT'],
    ['51', 'PE'],
    ['52', 'MX'],
    ['53', 'CU'],
    ['54', 'AR'],
    ['55', 'BR'],
    ['56', 'CL'],
    ['57', 'CO'],
    ['58', 'VE'],
    ['590', 'GP'],
    ['591', 'BO'],
    ['592', 'GY'],
    ['593', 'EC'],
    ['594', 'GF'],
    ['595', 'PY'],
    ['596', 'MQ'],
    ['597', 'SR'],
    ['598', 'UY'],
    ['599', 'CW'],
    // Asia / Pacific
    ['60', 'MY'],
    ['61', 'AU'],
    ['62', 'ID'],
    ['63', 'PH'],
    ['64', 'NZ'],
    ['65', 'SG'],
    ['66', 'TH'],
    ['670', 'TL'],
    ['672', 'NF'],
    ['673', 'BN'],
    ['674', 'NR'],
    ['675', 'PG'],
    ['676', 'TO'],
    ['677', 'SB'],
    ['678', 'VU'],
    ['679', 'FJ'],
    ['680', 'PW'],
    ['681', 'WF'],
    ['682', 'CK'],
    ['683', 'NU'],
    ['685', 'WS'],
    ['686', 'KI'],
    ['687', 'NC'],
    ['688', 'TV'],
    ['689', 'PF'],
    ['690', 'TK'],
    ['691', 'FM'],
    ['692', 'MH'],
    // Russia / Central Asia (7 6xx and 7 7xx are Kazakhstan)
    ['76', 'KZ'],
    ['77', 'KZ'],
    ['7', 'RU'],
    // East / South / West Asia
    ['81', 'JP'],
    ['82', 'KR'],
    ['84', 'VN'],
    ['850', 'KP'],
    ['852', 'HK'],
    ['853', 'MO'],
    ['855', 'KH'],
    ['856', 'LA'],
    ['86', 'CN'],
    ['880', 'BD'],
    ['886', 'TW'],
    ['90', 'TR'],
    ['91', 'IN'],
    ['92', 'PK'],
    ['93', 'AF'],
    ['94', 'LK'],
    ['95', 'MM'],
    ['960', 'MV'],
    ['961', 'LB'],
    ['962', 'JO'],
    ['963', 'SY'],
    ['964', 'IQ'],
    ['965', 'KW'],
    ['966', 'SA'],
    ['967', 'YE'],
    ['968', 'OM'],
    ['970', 'PS'],
    ['971', 'AE'],
    ['972', 'IL'],
    ['973', 'BH'],
    ['974', 'QA'],
    ['975', 'BT'],
    ['976', 'MN'],
    ['977', 'NP'],
    ['98', 'IR'],
    ['992', 'TJ'],
    ['993', 'TM'],
    ['994', 'AZ'],
    ['995', 'GE'],
    ['996', 'KG'],
    ['998', 'UZ'],
    // Bare NANP last — every longer '1' prefix above is tested first.
    ['1', 'US'],
  ] as ReadonlyArray<readonly [string, string]>
)
  .slice()
  .sort((a, b) => b[0].length - a[0].length);

/** Shortest / longest E.164 subscriber numbers, used to reject non-phone ids. */
const MIN_E164_DIGITS = 7;
const MAX_E164_DIGITS = 15;

/**
 * Map a messaging-platform user id to an ISO 3166-1 alpha-2 country, or
 * `undefined` when the id is not a phone number or its calling code is not
 * recognized. Never throws.
 */
export function countryFromPhoneUserId(userId: string | undefined): string | undefined {
  if (!userId) return undefined;

  // Platform ids arrive bare ("559291836442"); tolerate a leading + or spacing.
  const digits = userId.replace(/[^0-9]/g, '');
  if (
    digits.length !== userId.replace(/^\+/, '').length ||
    digits.length < MIN_E164_DIGITS ||
    digits.length > MAX_E164_DIGITS
  ) {
    return undefined;
  }

  for (const [prefix, country] of CALLING_CODES) {
    if (!digits.startsWith(prefix)) continue;
    if (prefix === '1') {
      return CANADA_AREA_CODES.has(digits.slice(1, 4)) ? 'CA' : 'US';
    }
    return country;
  }
  return undefined;
}
