import type { MedicationPrescribedEvent } from '../../domain/clinical-event.ts';
import { foldText } from '../support/text.ts';

/**
 * WHO ATC classification of a prescription. Hosts often send medications as
 * free text ("Apixabán 5 mg", "metformin 500 mg BID"); this table maps
 * Spanish, English and international (INN) names to their ATC code so a rule can reason by drug class
 * (`B01` antithrombotics, `J01` antibacterials). A terminology fact, not a
 * clinical policy: which classes are chronic or acute is the rule's config.
 */

export const ATC_SYSTEM = 'http://www.whocc.no/atc';

/** An ATC code: anatomical group letter, two-digit therapeutic group, then optional levels. */
const ATC_PATTERN = /^[A-Z]\d{2}([A-Z]{1,2}(\d{2})?)?$/;

interface AtcName {
  readonly atc: string;
  /**
   * Accent-insensitive name stems matched at the start of a word ("atorvastat"
   * matches "Atorvastatina"); several words match as a phrase.
   */
  readonly names: readonly string[];
  /** Only up to this strength in mg (aspirin 100 mg is an antiplatelet, 500 mg an analgesic). */
  readonly maxMg?: number;
  /** Not when the text has one of these words (a nasal spray is not an inhaler). */
  readonly unless?: readonly string[];
}

/**
 * The drug named first in the text wins; for the same name, the first entry
 * that applies (dose-dependent and combination entries come first).
 */
const ATC_NAMES: readonly AtcName[] = [
  // A02 acid-related disorders
  { atc: 'A02BC01', names: ['omeprazol'] },
  { atc: 'A02BC05', names: ['esomeprazol'] },
  { atc: 'A02BC02', names: ['pantoprazol'] },
  { atc: 'A02BC03', names: ['lansoprazol'] },
  { atc: 'A02BA02', names: ['ranitidin'] },
  { atc: 'A02BA03', names: ['famotidin'] },
  // A03 functional gastrointestinal disorders
  { atc: 'A03BB01', names: ['butilhioscina', 'hioscina', 'hyoscine', 'butylscopolamine'] },
  { atc: 'A03FA01', names: ['metoclopramid'] },
  { atc: 'A03FA03', names: ['domperidon'] },
  { atc: 'A03AA05', names: ['trimebutin'] },
  // A04 antiemetics, A07 antidiarrheals
  { atc: 'A04AA01', names: ['ondansetron'] },
  { atc: 'A07DA03', names: ['loperamid'] },
  { atc: 'A07XA04', names: ['racecadotril'] },
  { atc: 'A07CA', names: ['sales de rehidratacion', 'suero oral'] },
  // A10 drugs used in diabetes
  { atc: 'A10A', names: ['insulin'] },
  { atc: 'A10BA02', names: ['metformin'] },
  { atc: 'A10BB01', names: ['glibenclamid', 'glyburid'] },
  { atc: 'A10BB12', names: ['glimepirid'] },
  { atc: 'A10BB09', names: ['gliclazid'] },
  { atc: 'A10BB07', names: ['glipizid'] },
  { atc: 'A10BH01', names: ['sitagliptin'] },
  { atc: 'A10BH02', names: ['vildagliptin'] },
  { atc: 'A10BH03', names: ['saxagliptin'] },
  { atc: 'A10BH05', names: ['linagliptin'] },
  { atc: 'A10BK01', names: ['dapagliflozin'] },
  { atc: 'A10BK02', names: ['canagliflozin'] },
  { atc: 'A10BK03', names: ['empagliflozin'] },
  { atc: 'A10BJ02', names: ['liraglutid'] },
  { atc: 'A10BJ05', names: ['dulaglutid'] },
  { atc: 'A10BJ06', names: ['semaglutid'] },
  { atc: 'A10BG03', names: ['pioglitazon'] },
  { atc: 'A10BX16', names: ['tirzepatid'] },
  // B01 antithrombotic agents (aspirin by strength: antiplatelet up to 325 mg)
  { atc: 'B01AF02', names: ['apixaban'] },
  { atc: 'B01AF01', names: ['rivaroxaban'] },
  { atc: 'B01AF03', names: ['edoxaban'] },
  { atc: 'B01AE07', names: ['dabigatran'] },
  { atc: 'B01AA03', names: ['warfarin'] },
  { atc: 'B01AA07', names: ['acenocumarol', 'acenocoumarol'] },
  { atc: 'B01AC04', names: ['clopidogrel'] },
  { atc: 'B01AC22', names: ['prasugrel'] },
  { atc: 'B01AC24', names: ['ticagrelor'] },
  { atc: 'B01AC23', names: ['cilostazol'] },
  { atc: 'B01AB05', names: ['enoxaparin'] },
  { atc: 'B01AB01', names: ['heparin'] },
  {
    atc: 'B01AC06',
    names: ['acido acetilsalicilico', 'acetylsalicylic acid', 'aspirin', 'aas'],
    maxMg: 325,
  },
  { atc: 'N02BA01', names: ['acido acetilsalicilico', 'acetylsalicylic acid', 'aspirin', 'aas'] },
  // B03 antianemic preparations
  { atc: 'B03AA07', names: ['sulfato ferroso', 'ferrous sulfate', 'hierro'] },
  { atc: 'B03BB01', names: ['acido folico', 'folic acid'] },
  // C cardiovascular system
  { atc: 'C01AA05', names: ['digoxin'] },
  { atc: 'C01BD01', names: ['amiodaron'] },
  { atc: 'C01DA', names: ['isosorbid'] },
  { atc: 'C01EB17', names: ['ivabradin'] },
  { atc: 'C02AB01', names: ['metildopa', 'methyldopa'] },
  { atc: 'C02AC01', names: ['clonidin'] },
  { atc: 'C02CA04', names: ['doxazosin'] },
  { atc: 'C02CA01', names: ['prazosin'] },
  { atc: 'C02DB02', names: ['hidralazin', 'hydralazin'] },
  { atc: 'C03AA03', names: ['hidroclorotiazid', 'hydrochlorothiazid'] },
  { atc: 'C03BA04', names: ['clortalidon', 'chlortalidon', 'chlorthalidon'] },
  { atc: 'C03BA11', names: ['indapamid'] },
  { atc: 'C03CA01', names: ['furosemid'] },
  { atc: 'C03DA01', names: ['espironolacton', 'spironolacton'] },
  { atc: 'C03DA04', names: ['eplerenon'] },
  { atc: 'C07AA05', names: ['propranolol'] },
  { atc: 'C07AB02', names: ['metoprolol'] },
  { atc: 'C07AB03', names: ['atenolol'] },
  { atc: 'C07AB07', names: ['bisoprolol'] },
  { atc: 'C07AB12', names: ['nebivolol'] },
  { atc: 'C07AG02', names: ['carvedilol'] },
  { atc: 'C08CA01', names: ['amlodipin'] },
  { atc: 'C08CA02', names: ['felodipin'] },
  { atc: 'C08CA05', names: ['nifedipin'] },
  { atc: 'C08DA01', names: ['verapamil'] },
  { atc: 'C08DB01', names: ['diltiazem'] },
  { atc: 'C09AA01', names: ['captopril'] },
  { atc: 'C09AA02', names: ['enalapril'] },
  { atc: 'C09AA03', names: ['lisinopril'] },
  { atc: 'C09AA04', names: ['perindopril'] },
  { atc: 'C09AA05', names: ['ramipril'] },
  { atc: 'C09CA01', names: ['losartan'] },
  { atc: 'C09CA03', names: ['valsartan'] },
  { atc: 'C09CA04', names: ['irbesartan'] },
  { atc: 'C09CA06', names: ['candesartan'] },
  { atc: 'C09CA07', names: ['telmisartan'] },
  { atc: 'C09CA08', names: ['olmesartan'] },
  { atc: 'C09DX04', names: ['sacubitril'] },
  { atc: 'C10AA01', names: ['simvastat'] },
  { atc: 'C10AA02', names: ['lovastat'] },
  { atc: 'C10AA03', names: ['pravastat'] },
  { atc: 'C10AA05', names: ['atorvastat'] },
  { atc: 'C10AA07', names: ['rosuvastat'] },
  { atc: 'C10AA08', names: ['pitavastat'] },
  { atc: 'C10AB04', names: ['gemfibrozil'] },
  { atc: 'C10AB05', names: ['fenofibrat'] },
  { atc: 'C10AX09', names: ['ezetimib'] },
  // D, G01 topical and gynecological anti-infectives
  { atc: 'D01AC01', names: ['clotrimazol'] },
  { atc: 'D06AX09', names: ['mupirocin'] },
  // G03 sex hormones, G04 urologicals
  { atc: 'G03AA', names: ['etinilestradiol', 'ethinylestradiol', 'drospirenon', 'anticonceptiv'] },
  { atc: 'G03AC09', names: ['desogestrel'] },
  { atc: 'G03AC03', names: ['levonorgestrel'] },
  { atc: 'G03CA03', names: ['estradiol'] },
  { atc: 'G04BD04', names: ['oxibutinin', 'oxybutynin'] },
  { atc: 'G04BD07', names: ['tolterodin'] },
  { atc: 'G04BD08', names: ['solifenacin'] },
  { atc: 'G04BD12', names: ['mirabegron'] },
  { atc: 'G04CA01', names: ['alfuzosin'] },
  { atc: 'G04CA02', names: ['tamsulosin'] },
  { atc: 'G04CA04', names: ['silodosin'] },
  { atc: 'G04CB01', names: ['finasterid'] },
  { atc: 'G04CB02', names: ['dutasterid'] },
  // H02 corticosteroids, H03 thyroid
  { atc: 'H02AB07', names: ['prednison'] },
  { atc: 'H02AB06', names: ['prednisolon'] },
  { atc: 'H02AB02', names: ['dexametason', 'dexamethason'] },
  { atc: 'H02AB04', names: ['metilprednisolon', 'methylprednisolon'] },
  { atc: 'H02AB13', names: ['deflazacort'] },
  { atc: 'H03AA01', names: ['levotirox', 'levothyrox'] },
  { atc: 'H03AA02', names: ['liotironin', 'liothyronin'] },
  { atc: 'H03BB02', names: ['tiamazol', 'thiamazol', 'metimazol', 'methimazol'] },
  { atc: 'H03BA02', names: ['propiltiouracil', 'propylthiouracil'] },
  // J anti-infectives for systemic use
  { atc: 'J01CA04', names: ['amoxicilin', 'amoxicillin'] },
  { atc: 'J01CA01', names: ['ampicilin', 'ampicillin'] },
  { atc: 'J01CE', names: ['penicilin', 'penicillin'] },
  { atc: 'J01CF01', names: ['dicloxacilin', 'dicloxacillin'] },
  { atc: 'J01DB01', names: ['cefalexin', 'cephalexin'] },
  { atc: 'J01DB05', names: ['cefadroxil'] },
  { atc: 'J01DC02', names: ['cefuroxim'] },
  { atc: 'J01DD08', names: ['cefixim'] },
  { atc: 'J01DD04', names: ['ceftriaxon'] },
  { atc: 'J01FA10', names: ['azitromicin', 'azithromycin'] },
  { atc: 'J01FA09', names: ['claritromicin', 'clarithromycin'] },
  { atc: 'J01FA01', names: ['eritromicin', 'erythromycin'] },
  { atc: 'J01FF01', names: ['clindamicin', 'clindamycin'] },
  { atc: 'J01MA02', names: ['ciprofloxacin'] },
  { atc: 'J01MA12', names: ['levofloxacin'] },
  { atc: 'J01MA14', names: ['moxifloxacin'] },
  { atc: 'J01MA06', names: ['norfloxacin'] },
  { atc: 'J01AA02', names: ['doxiciclin', 'doxycyclin'] },
  { atc: 'J01EE01', names: ['trimetoprim', 'trimethoprim', 'cotrimoxazol', 'sulfametoxazol'] },
  { atc: 'J01XE01', names: ['nitrofurantoin'] },
  { atc: 'J01XX01', names: ['fosfomicin', 'fosfomycin'] },
  { atc: 'J02AC01', names: ['fluconazol'] },
  { atc: 'J02AC02', names: ['itraconazol'] },
  { atc: 'J05AB01', names: ['aciclovir', 'acyclovir'] },
  { atc: 'J05AB11', names: ['valaciclovir', 'valacyclovir'] },
  { atc: 'J05AH02', names: ['oseltamivir'] },
  // L antineoplastic and immunomodulating agents
  { atc: 'L02BA01', names: ['tamoxifen'] },
  { atc: 'L02BG03', names: ['anastrozol'] },
  { atc: 'L02BG04', names: ['letrozol'] },
  { atc: 'L04AX03', names: ['metotrexat', 'methotrexat'] },
  { atc: 'L04AX01', names: ['azatioprin', 'azathioprin'] },
  // M musculo-skeletal system
  { atc: 'M01AE01', names: ['ibuprofen'] },
  { atc: 'M01AE02', names: ['naproxen'] },
  { atc: 'M01AE03', names: ['ketoprofen'] },
  { atc: 'M01AE17', names: ['dexketoprofen'] },
  { atc: 'M01AB05', names: ['diclofenac'] },
  { atc: 'M01AB15', names: ['ketorolac'] },
  { atc: 'M01AB16', names: ['aceclofenac'] },
  { atc: 'M01AB01', names: ['indometacin', 'indomethacin'] },
  { atc: 'M01AC06', names: ['meloxicam'] },
  { atc: 'M01AH01', names: ['celecoxib'] },
  { atc: 'M01AH05', names: ['etoricoxib'] },
  { atc: 'M01AX17', names: ['nimesulid'] },
  { atc: 'M03BX08', names: ['ciclobenzaprin', 'cyclobenzaprin'] },
  { atc: 'M03BX05', names: ['tiocolchicosid', 'thiocolchicosid'] },
  { atc: 'M03BA03', names: ['metocarbamol', 'methocarbamol'] },
  { atc: 'M03BC01', names: ['orfenadrin', 'orphenadrin'] },
  { atc: 'M04AA01', names: ['alopurinol', 'allopurinol'] },
  { atc: 'M04AA03', names: ['febuxostat'] },
  { atc: 'M04AC01', names: ['colchicin'] },
  { atc: 'M05BA04', names: ['alendron'] },
  { atc: 'M05BA06', names: ['ibandron'] },
  { atc: 'M05BA07', names: ['risedron'] },
  // N nervous system
  { atc: 'N02BE01', names: ['paracetamol', 'acetaminofen', 'acetaminophen'] },
  { atc: 'N02BB02', names: ['metamizol', 'dipiron'] },
  { atc: 'N02AX02', names: ['tramadol'] },
  { atc: 'N02AJ06', names: ['codein'] },
  { atc: 'N02CC01', names: ['sumatriptan'] },
  { atc: 'N03AG01', names: ['valproat', 'acido valproico', 'valproic acid'] },
  { atc: 'N03AF01', names: ['carbamazepin'] },
  { atc: 'N03AF02', names: ['oxcarbazepin'] },
  { atc: 'N03AX09', names: ['lamotrigin'] },
  { atc: 'N03AX11', names: ['topiramat'] },
  { atc: 'N03AX12', names: ['gabapentin'] },
  { atc: 'N03AX14', names: ['levetiracetam'] },
  { atc: 'N03AX16', names: ['pregabalin'] },
  { atc: 'N03AB02', names: ['fenitoin', 'phenytoin'] },
  { atc: 'N04BA', names: ['levodopa'] },
  { atc: 'N04BC05', names: ['pramipexol'] },
  { atc: 'N04BC04', names: ['ropinirol'] },
  { atc: 'N04BD02', names: ['rasagilin'] },
  { atc: 'N05AD01', names: ['haloperidol'] },
  { atc: 'N05AH02', names: ['clozapin'] },
  { atc: 'N05AH03', names: ['olanzapin'] },
  { atc: 'N05AH04', names: ['quetiapin'] },
  { atc: 'N05AX08', names: ['risperidon'] },
  { atc: 'N05AX12', names: ['aripiprazol'] },
  { atc: 'N05AN01', names: ['litio', 'lithium', 'carbonato de litio'] },
  { atc: 'N05BA12', names: ['alprazolam'] },
  { atc: 'N05BA06', names: ['lorazepam'] },
  { atc: 'N05BA01', names: ['diazepam'] },
  { atc: 'N05BA08', names: ['bromazepam'] },
  { atc: 'N05BE01', names: ['buspiron'] },
  { atc: 'N05CF02', names: ['zolpidem'] },
  { atc: 'N05CF01', names: ['zopiclon'] },
  { atc: 'N03AE01', names: ['clonazepam'] },
  { atc: 'N06AA09', names: ['amitriptilin', 'amitriptylin'] },
  { atc: 'N06AA02', names: ['imipramin'] },
  { atc: 'N06AA04', names: ['clomipramin'] },
  { atc: 'N06AA10', names: ['nortriptilin', 'nortriptylin'] },
  { atc: 'N06AB08', names: ['fluvoxamin'] },
  { atc: 'N06AB03', names: ['fluoxetin'] },
  { atc: 'N06AB04', names: ['citalopram'] },
  { atc: 'N06AB05', names: ['paroxetin'] },
  { atc: 'N06AB06', names: ['sertralin'] },
  { atc: 'N06AB10', names: ['escitalopram'] },
  { atc: 'N06AX05', names: ['trazodon'] },
  { atc: 'N06AX11', names: ['mirtazapin'] },
  { atc: 'N06AX12', names: ['bupropion'] },
  { atc: 'N06AX16', names: ['venlafaxin'] },
  { atc: 'N06AX21', names: ['duloxetin'] },
  { atc: 'N06AX23', names: ['desvenlafaxin'] },
  { atc: 'N06AX26', names: ['vortioxetin'] },
  { atc: 'N06AX03', names: ['mianserin'] },
  { atc: 'N06AX22', names: ['agomelatin'] },
  { atc: 'N06BA04', names: ['metilfenidat', 'methylphenidat'] },
  { atc: 'N06BA09', names: ['atomoxetin'] },
  { atc: 'N06DA02', names: ['donepezil'] },
  { atc: 'N06DA03', names: ['rivastigmin'] },
  { atc: 'N06DA04', names: ['galantamin'] },
  { atc: 'N06DX01', names: ['memantin'] },
  // P antiparasitic products
  { atc: 'P01AB01', names: ['metronidazol'] },
  { atc: 'P01AB02', names: ['tinidazol'] },
  { atc: 'P01AX11', names: ['nitazoxanid'] },
  { atc: 'P01BA02', names: ['hidroxicloroquin', 'hydroxychloroquin'] },
  { atc: 'P02CA03', names: ['albendazol'] },
  { atc: 'P02CA01', names: ['mebendazol'] },
  { atc: 'P02CF01', names: ['ivermectin'] },
  // R respiratory system (inhaled corticosteroids, not their nasal sprays)
  { atc: 'R03AK07', names: ['formoterol'] },
  { atc: 'R03AK06', names: ['salmeterol'] },
  { atc: 'R03AC02', names: ['salbutamol', 'albuterol'] },
  { atc: 'R03BB04', names: ['tiotropio', 'tiotropium'] },
  { atc: 'R03BB01', names: ['ipratropio', 'ipratropium'] },
  { atc: 'R03DC03', names: ['montelukast'] },
  { atc: 'R03BA02', names: ['budesonid'], unless: ['nasal'] },
  { atc: 'R03BA05', names: ['fluticason'], unless: ['nasal'] },
  { atc: 'R03BA01', names: ['beclometason', 'beclomethason'], unless: ['nasal'] },
  { atc: 'R01AD05', names: ['budesonid'] },
  { atc: 'R01AD08', names: ['fluticason'] },
  { atc: 'R05CB06', names: ['ambroxol'] },
  { atc: 'R05CB01', names: ['acetilcistein', 'acetylcystein'] },
  { atc: 'R05CB02', names: ['bromhexin'] },
  { atc: 'R05DA09', names: ['dextrometorfan', 'dextromethorphan'] },
  { atc: 'R06AX13', names: ['loratadin'] },
  { atc: 'R06AX27', names: ['desloratadin'] },
  { atc: 'R06AE07', names: ['cetirizin'] },
  { atc: 'R06AE09', names: ['levocetirizin'] },
  { atc: 'R06AX26', names: ['fexofenadin'] },
  { atc: 'R06AB04', names: ['clorfenamin', 'chlorphenamin'] },
  // S01 ophthalmologicals
  { atc: 'S01EE01', names: ['latanoprost'] },
  { atc: 'S01ED01', names: ['timolol'] },
  { atc: 'S01EC03', names: ['dorzolamid'] },
  { atc: 'S01EA05', names: ['brimonidin'] },
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const STEM_PATTERNS = new Map<string, RegExp>();

/** Where a name stem starts a word of the folded text ("losartan" in "losartan/hctz"), or -1. */
function wordStart(folded: string, stem: string): number {
  let pattern = STEM_PATTERNS.get(stem);
  if (pattern === undefined) {
    pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(foldText(stem))}`, 'u');
    STEM_PATTERNS.set(stem, pattern);
  }
  const match = pattern.exec(folded);
  return match === null ? -1 : match.index + (match[1]?.length ?? 0);
}

/** The strength in mg written in the text ("100 mg", "0,4 mg"), if any. */
function strengthMg(folded: string): number | undefined {
  const match = /(\d+(?:[.,]\d+)?)\s*mg\b/u.exec(folded);
  return match?.[1] === undefined ? undefined : Number(match[1].replace(',', '.'));
}

/**
 * The ATC code of a medication name ("Apixabán 5 mg" is `B01AF02`), if the
 * table knows it. In a combination the drug named first wins
 * ("Losartán/Hidroclorotiazida" is `C09CA01`).
 */
export function atcCodeOfName(text: string): string | undefined {
  const folded = foldText(text);
  const mg = strengthMg(folded);
  let best: { readonly atc: string; readonly at: number } | undefined;
  for (const entry of ATC_NAMES) {
    if (
      (entry.unless ?? []).some((word) => wordStart(folded, word) >= 0) ||
      (entry.maxMg !== undefined && (mg === undefined || mg > entry.maxMg))
    ) {
      continue;
    }
    const positions = entry.names.map((name) => wordStart(folded, name)).filter((at) => at >= 0);
    const at = positions.length === 0 ? -1 : Math.min(...positions);
    if (at >= 0 && (best === undefined || at < best.at)) {
      best = { atc: entry.atc, at };
    }
  }
  return best?.atc;
}

/** The name stems the table knows for an ATC code ("atorvastat" for `C10AA05`). */
export function atcNamesOf(atc: string): readonly string[] {
  return ATC_NAMES.filter((entry) => entry.atc === atc).flatMap((entry) => entry.names);
}

/** Every ATC code the name table knows, each with its name stems (the rule-authoring catalog). */
export function knownAtcCodes(): readonly {
  readonly atc: string;
  readonly names: readonly string[];
}[] {
  const byCode = new Map<string, string[]>();
  for (const entry of ATC_NAMES) {
    byCode.set(entry.atc, [...(byCode.get(entry.atc) ?? []), ...entry.names]);
  }
  return [...byCode.entries()].map(([atc, names]) => ({ atc, names: [...new Set(names)] }));
}

/** Whether `code` is written like an ATC code (`B01AF02`, `C10`). */
export function isAtcCode(code: string): boolean {
  return ATC_PATTERN.test(code.trim().toUpperCase());
}

/**
 * The ATC code of a prescription: its own code when it is ATC, else the
 * code its name maps to (an uncoded or RxNorm-coded "Clopidogrel 75 mg").
 */
export function atcCodeOf(medication: MedicationPrescribedEvent['medication']): string | undefined {
  const code = medication.code;
  if (code !== undefined && (code.system === ATC_SYSTEM || isAtcCode(code.code))) {
    return code.code.trim().toUpperCase();
  }
  return atcCodeOfName(`${medication.text} ${code?.display ?? ''}`);
}
