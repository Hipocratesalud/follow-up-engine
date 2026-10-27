/**
 * Which words in a note can support which diagnosis. The extractor accepts a
 * model's condition only when its evidence quote contains a term listed here
 * for the condition's ICD-10 category (3 characters), so a quote like "DM2"
 * can back E11 but never B20, and a code missing from this table is not
 * accepted from free text at all.
 *
 * Configuration, not logic: terms are Spanish as written in Latin American
 * outpatient notes (abbreviations included), compared lowercase and without
 * accents, as whole words. Add a category (or a synonym) here, with a gold
 * note that needs it, when the clinical team enables a new condition; the
 * table can also be replaced per deployment (`NoteExtractorOptions.conditionTerms`).
 */
export type ConditionTermTable = Readonly<Record<string, readonly string[]>>;

const DIABETES = ['diabetes', 'diabetes mellitus', 'diabetico', 'diabetica', 'dm'];
const HYPERTENSION = [
  'hta',
  'hipertension',
  'hipertension arterial',
  'hipertenso',
  'hipertensa',
  'presion alta',
  'tension alta',
];
const ANEMIA = ['anemia', 'anemico', 'anemica'];
const ANXIETY = [
  'ansiedad',
  'ansioso',
  'ansiosa',
  'tag',
  'trastorno de ansiedad',
  'trastorno de panico',
  'panico',
  'angustia',
];
const DEPRESSION = [
  'depresion',
  'depresivo',
  'depresiva',
  'episodio depresivo',
  'trastorno depresivo',
];
const OSTEOARTHRITIS = ['artrosis', 'osteoartrosis', 'osteoartritis'];
const HEADACHE = ['cefalea', 'cefaleas'];
const THROAT = ['faringitis', 'faringoamigdalitis', 'amigdalitis', 'odinofagia'];

export const DEFAULT_CONDITION_TERMS: ConditionTermTable = {
  // Endocrine and metabolic
  E10: ['diabetes tipo 1', 'diabetes mellitus tipo 1', 'dm1', 'dm 1', 'dm tipo 1', 'dmt1'],
  E11: [
    ...DIABETES,
    'dm2',
    'dm 2',
    'dm ii',
    'dm tipo 2',
    'dmt2',
    'pie diabetico',
    'diabetes tipo 2',
  ],
  E13: DIABETES,
  E14: DIABETES,
  R73: [
    'prediabetes',
    'prediabetico',
    'prediabetica',
    'glicemia alterada',
    'glucemia alterada',
    'intolerancia a la glucosa',
    'resistencia a la insulina',
    'hiperglicemia',
    'hiperglucemia',
  ],
  E78: [
    'dislipidemia',
    'dislipemia',
    'hipercolesterolemia',
    'hipertrigliceridemia',
    'hiperlipidemia',
    'colesterol alto',
    'trigliceridos altos',
  ],
  E03: ['hipotiroidismo', 'hipotiroideo', 'hipotiroidea', 'hashimoto', 'tiroiditis'],
  E05: ['hipertiroidismo', 'tirotoxicosis', 'enfermedad de graves', 'graves'],
  E04: ['bocio', 'nodulo tiroideo', 'nodulos tiroideos'],
  E66: ['obesidad', 'obeso', 'obesa', 'sobrepeso'],
  E28: ['sop', 'ovario poliquistico', 'ovarios poliquisticos', 'poliquistosis ovarica'],
  E55: ['deficit de vitamina d', 'deficiencia de vitamina d', 'hipovitaminosis d'],
  E79: ['hiperuricemia', 'acido urico elevado'],
  E87: [
    'hiperpotasemia',
    'hipopotasemia',
    'hiperkalemia',
    'hipokalemia',
    'hiponatremia',
    'hipernatremia',
  ],
  // Blood
  D50: [...ANEMIA, 'anemia ferropenica', 'ferropenia', 'ferropenica', 'deficit de hierro'],
  D64: ANEMIA,
  // Circulatory
  I10: HYPERTENSION,
  I11: [...HYPERTENSION, 'cardiopatia hipertensiva'],
  I12: [...HYPERTENSION, 'nefropatia hipertensiva'],
  I20: ['angina', 'angor'],
  I21: ['infarto', 'iam', 'sindrome coronario agudo'],
  I25: ['cardiopatia isquemica', 'enfermedad coronaria', 'coronariopatia'],
  I48: ['fibrilacion auricular', 'fa', 'acxfa', 'flutter auricular', 'flutter'],
  I50: ['insuficiencia cardiaca', 'icc', 'ic', 'falla cardiaca'],
  I83: ['varices', 'insuficiencia venosa'],
  I95: ['hipotension'],
  // Respiratory
  J00: ['resfriado', 'resfriado comun', 'rinofaringitis', 'catarro'],
  J01: ['sinusitis'],
  J02: THROAT,
  J03: THROAT,
  J06: ['ira alta', 'iras', 'ira', 'infeccion respiratoria alta', 'infeccion respiratoria aguda'],
  J18: ['neumonia'],
  J20: ['bronquitis aguda', 'bronquitis'],
  J30: ['rinitis', 'rinitis alergica'],
  J44: ['epoc', 'enfermedad pulmonar obstructiva cronica', 'bronquitis cronica', 'enfisema'],
  J45: ['asma', 'asmatico', 'asmatica', 'broncoespasmo'],
  // Digestive
  A09: ['gastroenteritis', 'gea', 'diarrea aguda'],
  K21: ['erge', 'reflujo', 'reflujo gastroesofagico'],
  K29: ['gastritis'],
  K30: ['dispepsia'],
  K58: ['colon irritable', 'sii', 'intestino irritable'],
  K59: ['estrenimiento', 'constipacion'],
  // Musculoskeletal and injuries
  M10: ['gota', 'artritis gotosa'],
  M15: OSTEOARTHRITIS,
  M16: [...OSTEOARTHRITIS, 'coxartrosis'],
  M17: [...OSTEOARTHRITIS, 'gonartrosis'],
  M19: OSTEOARTHRITIS,
  M54: [
    'lumbalgia',
    'lumbago',
    'lumbociatalgia',
    'ciatalgia',
    'cervicalgia',
    'dorsalgia',
    'dolor lumbar',
  ],
  M79: ['fibromialgia', 'mialgia', 'mialgias'],
  M81: ['osteoporosis'],
  M85: ['osteopenia'],
  S83: ['esguince de rodilla', 'esguince'],
  S93: ['esguince de tobillo', 'esguince', 'torcedura de tobillo'],
  // Nervous system and mental health
  G43: ['migrana', 'jaqueca'],
  G44: HEADACHE,
  R51: HEADACHE,
  G47: ['insomnio', 'apnea del sueno', 'trastorno del sueno'],
  F51: ['insomnio', 'trastorno del sueno'],
  F10: ['alcoholismo', 'consumo de alcohol', 'abuso de alcohol'],
  F17: ['tabaquismo', 'fumador', 'fumadora'],
  F20: ['esquizofrenia'],
  F31: ['bipolar', 'trastorno bipolar'],
  F32: DEPRESSION,
  F33: [...DEPRESSION, 'depresion recurrente', 'trastorno depresivo recurrente'],
  F40: ['fobia', 'fobia social', 'agorafobia'],
  F41: ANXIETY,
  F42: ['toc', 'trastorno obsesivo', 'trastorno obsesivo compulsivo'],
  F43: [
    'estres',
    'trastorno adaptativo',
    'adaptativo',
    'reaccion a estres',
    'estres postraumatico',
    'tept',
    'duelo',
  ],
  F90: ['tdah', 'deficit de atencion'],
  // Genitourinary
  N18: ['erc', 'enfermedad renal cronica', 'insuficiencia renal cronica', 'irc', 'nefropatia'],
  N30: [
    'cistitis',
    'itu baja',
    'ivu baja',
    'infeccion urinaria baja',
    'infeccion de vias urinarias bajas',
  ],
  N39: ['itu', 'ivu', 'infeccion urinaria', 'infeccion de vias urinarias', 'cistitis'],
  N40: ['hpb', 'hiperplasia prostatica', 'crecimiento prostatico'],
  N60: ['mastopatia fibroquistica', 'mastopatia'],
  N63: ['nodulo mamario', 'nodulo de mama'],
  N76: ['vaginosis', 'vaginitis', 'vulvovaginitis'],
  N91: ['amenorrea', 'oligomenorrea'],
  N92: [
    'menorragia',
    'hipermenorrea',
    'metrorragia',
    'polimenorrea',
    'sangrado menstrual abundante',
  ],
  N94: ['dismenorrea'],
  N95: ['climaterio', 'climaterico', 'menopausia', 'perimenopausia', 'sofocos'],
  N97: ['infertilidad', 'esterilidad'],
  D25: ['mioma', 'miomas', 'miomatosis', 'leiomioma'],
  R87: ['asc-us', 'ascus', 'lsil', 'hsil', 'citologia anormal', 'pap anormal'],
  // Infections and skin
  B35: ['tina', 'onicomicosis', 'dermatofitosis'],
  B37: ['candidiasis', 'moniliasis', 'candida'],
  H10: ['conjuntivitis'],
  H66: ['otitis', 'otitis media'],
  L20: ['dermatitis atopica'],
  L30: ['dermatitis'],
  L70: ['acne'],
  // Pregnancy and reproductive health
  O00: ['embarazo ectopico', 'ectopico', 'ectopico roto'],
  O02: [
    'huevo anembrionado',
    'embarazo anembrionado',
    'aborto retenido',
    'aborto diferido',
    'embarazo molar',
    'mola hidatiforme',
  ],
  O03: [
    'aborto',
    'aborto espontaneo',
    'aborto incompleto',
    'aborto completo',
    'perdida gestacional',
    'perdida del embarazo',
    'perdida temprana del embarazo',
  ],
  O13: ['hipertension gestacional', 'hta gestacional'],
  O14: ['preeclampsia'],
  O20: ['amenaza de aborto'],
  O21: ['hiperemesis'],
  O24: ['diabetes gestacional'],
  O80: ['parto', 'parto vaginal', 'parto eutocico', 'parto normal', 'parto espontaneo'],
  O82: ['cesarea', 'cesarea segmentaria', 'parto por cesarea', 'cesareada'],
  Z30: [
    'anticoncepcion',
    'anticonceptivo',
    'anticonceptivos',
    'diu',
    'implante subdermico',
    'planificacion familiar',
    'aco',
  ],
  Z32: ['prueba de embarazo'],
  Z33: ['embarazo', 'embarazada', 'gestacion', 'gestante', 'embarazo incidental'],
  Z34: ['embarazo', 'embarazada', 'gestacion', 'gestante', 'primigesta', 'control prenatal', 'cpn'],
  Z35: [
    'embarazo',
    'embarazada',
    'gestacion',
    'gestante',
    'control prenatal',
    'embarazo de alto riesgo',
    'alto riesgo obstetrico',
  ],
  Z39: ['puerperio', 'puerpera', 'postparto', 'posparto', 'post parto', 'puerperal'],
  // Symptoms and encounters
  R05: ['tos'],
  R10: ['dolor abdominal'],
  R50: ['fiebre', 'sindrome febril'],
  R53: ['astenia', 'fatiga', 'cansancio', 'adinamia'],
  Z00: ['chequeo', 'control de salud', 'examen de rutina', 'control de rutina'],
  Z01: [
    'control ginecologico',
    'chequeo ginecologico',
    'examen ginecologico',
    'control de rutina',
    'examen de rutina',
  ],
};

const EN_DIABETES = ['diabetes', 'diabetes mellitus', 'diabetic', 'dm'];
const EN_HYPERTENSION = [
  'htn',
  'hypertension',
  'hypertensive',
  'high blood pressure',
  'elevated blood pressure',
];
const EN_ANEMIA = ['anemia', 'anaemia', 'anemic'];
const EN_ANXIETY = [
  'anxiety',
  'anxious',
  'gad',
  'generalized anxiety disorder',
  'anxiety disorder',
  'panic disorder',
  'panic attacks',
];
const EN_DEPRESSION = [
  'depression',
  'depressed',
  'depressive',
  'mdd',
  'major depressive disorder',
  'depressive episode',
  'depressive disorder',
];
const EN_OSTEOARTHRITIS = ['osteoarthritis', 'oa', 'degenerative joint disease', 'djd'];
const EN_THROAT = ['pharyngitis', 'tonsillitis', 'sore throat', 'strep throat'];

/**
 * The same categories as {@link DEFAULT_CONDITION_TERMS}, worded as US-style
 * English notes write them ("T2DM", "HTN", "HLD", "CKD 3a", "GERD"). Used for
 * notes read as English (`conditionTermsFor('en')`).
 */
export const ENGLISH_CONDITION_TERMS: ConditionTermTable = {
  // Endocrine and metabolic
  E10: ['type 1 diabetes', 'type i diabetes', 'diabetes type 1', 't1dm', 'dm1', 'dm 1', 'iddm'],
  E11: [
    ...EN_DIABETES,
    't2dm',
    't2d',
    'dm2',
    'dm 2',
    'dm ii',
    'dmii',
    'niddm',
    'type 2 diabetes',
    'type ii diabetes',
    'diabetes type 2',
    'type 2 diabetes mellitus',
    'diabetic foot',
  ],
  E13: EN_DIABETES,
  E14: EN_DIABETES,
  R73: ['prediabetes', 'pre-diabetes', 'prediabetic', 'impaired fasting glucose', 'ifg'],
  E78: [
    'hyperlipidemia',
    'hld',
    'dyslipidemia',
    'hypercholesterolemia',
    'high cholesterol',
    'hypertriglyceridemia',
    'mixed hyperlipidemia',
  ],
  E03: ['hypothyroidism', 'hypothyroid', 'hashimoto', 'hashimotos', 'thyroiditis'],
  E05: ['hyperthyroidism', 'thyrotoxicosis', 'graves disease', 'graves'],
  E04: ['goiter', 'thyroid nodule', 'thyroid nodules'],
  E66: ['obesity', 'obese', 'overweight', 'morbid obesity'],
  E28: ['pcos', 'polycystic ovary syndrome', 'polycystic ovaries'],
  E55: ['vitamin d deficiency', 'vit d deficiency', 'low vitamin d'],
  E79: ['hyperuricemia'],
  E87: ['hypokalemia', 'hyperkalemia', 'hyponatremia', 'hypernatremia'],
  // Blood
  D50: [...EN_ANEMIA, 'iron deficiency anemia', 'ida', 'iron deficiency'],
  D64: EN_ANEMIA,
  // Circulatory
  I10: EN_HYPERTENSION,
  I11: [...EN_HYPERTENSION, 'hypertensive heart disease'],
  I12: [...EN_HYPERTENSION, 'hypertensive kidney disease', 'hypertensive nephropathy'],
  I20: ['angina'],
  I21: ['myocardial infarction', 'mi', 'heart attack', 'stemi', 'nstemi'],
  I25: ['coronary artery disease', 'cad', 'ischemic heart disease'],
  I48: ['atrial fibrillation', 'afib', 'a-fib', 'a fib', 'atrial flutter'],
  I50: ['heart failure', 'chf', 'hfref', 'hfpef', 'congestive heart failure'],
  I83: ['varicose veins', 'venous insufficiency'],
  I95: ['hypotension'],
  // Respiratory
  J00: ['common cold', 'cold', 'uri', 'nasopharyngitis'],
  J01: ['sinusitis'],
  J02: EN_THROAT,
  J03: EN_THROAT,
  J06: ['uri', 'upper respiratory infection', 'upper respiratory tract infection'],
  J18: ['pneumonia'],
  J20: ['acute bronchitis', 'bronchitis'],
  J30: ['allergic rhinitis', 'rhinitis', 'hay fever'],
  J44: ['copd', 'chronic obstructive pulmonary disease', 'emphysema', 'chronic bronchitis'],
  J45: ['asthma', 'asthmatic', 'bronchospasm'],
  // Digestive
  A09: ['gastroenteritis', 'acute diarrhea'],
  K21: ['gerd', 'reflux', 'acid reflux', 'gastroesophageal reflux'],
  K29: ['gastritis'],
  K30: ['dyspepsia'],
  K58: ['ibs', 'irritable bowel syndrome', 'irritable bowel'],
  K59: ['constipation'],
  // Musculoskeletal
  M10: ['gout'],
  M15: EN_OSTEOARTHRITIS,
  M16: ['hip osteoarthritis', 'hip oa'],
  M17: ['knee osteoarthritis', 'knee oa'],
  M19: EN_OSTEOARTHRITIS,
  M54: ['low back pain', 'lbp', 'back pain', 'lumbago', 'sciatica', 'neck pain'],
  M79: ['fibromyalgia', 'myalgia'],
  M81: ['osteoporosis'],
  M85: ['osteopenia'],
  // Nervous system
  G43: ['migraine', 'migraines'],
  G44: ['tension headache', 'tension-type headache'],
  R51: ['headache', 'headaches'],
  G47: ['insomnia', 'sleep apnea', 'osa'],
  F51: ['insomnia'],
  // Mental and behavioral
  F10: ['alcohol use disorder', 'alcohol dependence', 'alcohol abuse'],
  F17: ['tobacco use', 'smoker', 'nicotine dependence', 'tobacco use disorder'],
  F20: ['schizophrenia'],
  F31: ['bipolar disorder', 'bipolar'],
  F32: EN_DEPRESSION,
  F33: [...EN_DEPRESSION, 'recurrent depression', 'mdd recurrent'],
  F40: ['phobia', 'social anxiety'],
  F41: EN_ANXIETY,
  F42: ['ocd', 'obsessive-compulsive disorder', 'obsessive compulsive disorder'],
  F43: ['ptsd', 'adjustment disorder', 'acute stress reaction', 'grief'],
  F90: ['adhd', 'attention deficit'],
  // Genitourinary
  N18: ['ckd', 'chronic kidney disease', 'ckd stage 3', 'ckd 3a', 'ckd 3b', 'ckd stage 4'],
  N30: ['cystitis'],
  N39: ['uti', 'urinary tract infection'],
  N40: ['bph', 'benign prostatic hyperplasia', 'enlarged prostate'],
  N92: ['menorrhagia', 'heavy menstrual bleeding', 'abnormal uterine bleeding', 'aub'],
  N95: ['menopause', 'menopausal', 'perimenopause', 'postmenopausal'],
  D25: ['fibroid', 'fibroids', 'uterine fibroid', 'uterine fibroids', 'leiomyoma', 'myoma'],
  // Pregnancy
  O24: ['gestational diabetes', 'gdm'],
  O03: ['miscarriage', 'spontaneous abortion', 'pregnancy loss'],
  Z34: ['pregnancy', 'pregnant', 'intrauterine pregnancy', 'iup'],
  Z39: ['postpartum', 'post-partum'],
  // Symptoms and encounters
  R05: ['cough'],
  R10: ['abdominal pain'],
  R50: ['fever'],
  R53: ['fatigue'],
};

/** The condition terms a note in `language` is read with: English or Spanish (the default). */
export function conditionTermsFor(language: 'es' | 'en'): ConditionTermTable {
  return language === 'en' ? ENGLISH_CONDITION_TERMS : DEFAULT_CONDITION_TERMS;
}
