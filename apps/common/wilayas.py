"""The 58 Algerian wilayas, as a fixed list.

Two-digit **strings**, never integers: "01" must not become 1, because the code
is an identifier that happens to be made of digits — the same reason a phone
number is not a number.

This is the clearest case of the "fixed list or table?" question in the schema.
The list of wilayas is not the agencies' decision and changes roughly never, so
it is `choices` in code rather than rows someone can invent. See
`obsidian/Data Model/Data Model Overview.md`.

Arabic names are the official ones; verify any of these against ANIREF/ONS
before printing them on anything legal.
"""

WILAYAS = [
    ("01", "Adrar", "أدرار"),
    ("02", "Chlef", "الشلف"),
    ("03", "Laghouat", "الأغواط"),
    ("04", "Oum El Bouaghi", "أم البواقي"),
    ("05", "Batna", "باتنة"),
    ("06", "Béjaïa", "بجاية"),
    ("07", "Biskra", "بسكرة"),
    ("08", "Béchar", "بشار"),
    ("09", "Blida", "البليدة"),
    ("10", "Bouira", "البويرة"),
    ("11", "Tamanrasset", "تمنراست"),
    ("12", "Tébessa", "تبسة"),
    ("13", "Tlemcen", "تلمسان"),
    ("14", "Tiaret", "تيارت"),
    ("15", "Tizi Ouzou", "تيزي وزو"),
    ("16", "Alger", "الجزائر"),
    ("17", "Djelfa", "الجلفة"),
    ("18", "Jijel", "جيجل"),
    ("19", "Sétif", "سطيف"),
    ("20", "Saïda", "سعيدة"),
    ("21", "Skikda", "سكيكدة"),
    ("22", "Sidi Bel Abbès", "سيدي بلعباس"),
    ("23", "Annaba", "عنابة"),
    ("24", "Guelma", "قالمة"),
    ("25", "Constantine", "قسنطينة"),
    ("26", "Médéa", "المدية"),
    ("27", "Mostaganem", "مستغانم"),
    ("28", "M'Sila", "المسيلة"),
    ("29", "Mascara", "معسكر"),
    ("30", "Ouargla", "ورقلة"),
    ("31", "Oran", "وهران"),
    ("32", "El Bayadh", "البيض"),
    ("33", "Illizi", "إليزي"),
    ("34", "Bordj Bou Arréridj", "برج بوعريريج"),
    ("35", "Boumerdès", "بومرداس"),
    ("36", "El Tarf", "الطارف"),
    ("37", "Tindouf", "تندوف"),
    ("38", "Tissemsilt", "تيسمسيلت"),
    ("39", "El Oued", "الوادي"),
    ("40", "Khenchela", "خنشلة"),
    ("41", "Souk Ahras", "سوق أهراس"),
    ("42", "Tipaza", "تيبازة"),
    ("43", "Mila", "ميلة"),
    ("44", "Aïn Defla", "عين الدفلى"),
    ("45", "Naâma", "النعامة"),
    ("46", "Aïn Témouchent", "عين تموشنت"),
    ("47", "Ghardaïa", "غرداية"),
    ("48", "Relizane", "غليزان"),
    ("49", "Timimoun", "تيميمون"),
    ("50", "Bordj Badji Mokhtar", "برج باجي مختار"),
    ("51", "Ouled Djellal", "أولاد جلال"),
    ("52", "Béni Abbès", "بني عباس"),
    ("53", "In Salah", "عين صالح"),
    ("54", "In Guezzam", "عين قزام"),
    ("55", "Touggourt", "تقرت"),
    ("56", "Djanet", "جانت"),
    ("57", "El M'Ghair", "المغير"),
    ("58", "El Meniaa", "المنيعة"),
]

WILAYA_CHOICES = [(code, f"{code} — {fr}") for code, fr, _ar in WILAYAS]
WILAYA_NAMES_FR = {code: fr for code, fr, _ar in WILAYAS}
WILAYA_NAMES_AR = {code: ar for code, _fr, ar in WILAYAS}
WILAYA_CODES = frozenset(WILAYA_NAMES_FR)
