// Boarding Consent Form — Page 2 policy text, verbatim (ported from the
// legacy single-tenant app). Kept as an in-source constant (not read from a
// file at runtime) so it's guaranteed to be bundled into the packaged
// Electron app with no extra packaging/resource configuration. [Clinic
// Name] placeholders are substituted with the real clinic name at render
// time (see generate_invoice.js's parseConsentPolicyText); everything
// else is passed through untouched.
const CONSENT_POLICY_TEXT = `By signing this agreement, I acknowledge and agree to the following terms and conditions regarding my pet's stay at [Clinic Name]:

Health Declaration
I confirm that my pet is in good health and free from any known contagious or infectious disease.
I understand that all pets must be vaccinated (core vaccines and rabies, where applicable), dewormed, and treated for fleas and ticks before boarding. The clinic reserves the right to refuse admission if these requirements are not met.

Medical Treatment Authorization
I authorize the veterinarians and staff of [Clinic Name] to provide any necessary medical treatment if my pet becomes ill or is injured during boarding.
I understand that every reasonable effort will be made to contact me before treatment. However, in an emergency where I cannot be reached, I authorize the clinic to proceed with treatment in my pet's best interest.
I agree to pay all medical, hospitalization, medication, diagnostic, and emergency treatment costs incurred during my pet's stay.

Special Medical Conditions
I have fully disclosed any existing medical conditions, allergies, behavioral issues, medications, or special care requirements.
The clinic will administer owner-provided medications according to written instructions but is not responsible for complications resulting from inaccurate or incomplete information provided by the owner.

Risk Acknowledgement
While every reasonable precaution is taken to ensure the safety and well-being of all boarded pets, I understand that animals may experience illness, stress, injury, refusal to eat, or unforeseen medical conditions despite proper care.
[Clinic Name] and its staff shall not be held liable for illness, injury, death, escape, or loss arising from circumstances beyond their reasonable control, including undetected pre-existing conditions or force majeure events.

Aggressive or Dangerous Pets
If my pet displays aggressive or dangerous behavior requiring additional handling or sedation for the safety of staff or other animals, I authorize the clinic to take appropriate measures. Any associated charges will be my responsibility.

Personal Belongings
I understand that items left with my pet (beds, blankets, toys, bowls, collars, leashes, etc.) are left at my own risk. The clinic is not responsible for loss, damage, or destruction of personal belongings.

Payment Policy
Boarding charges are calculated according to the agreed boarding period.
Additional services, including medications, veterinary examinations, emergency treatment, grooming, bathing, nail trimming, vaccinations, deworming, or any other requested services, will be charged separately.
Full payment is due at the time of pickup unless otherwise agreed in writing.
The clinic may require partial or full advance payment before or during boarding.
Pets may not be released until all outstanding balances have been paid in full.

Late Pickup
Pets not collected on the agreed pickup date and time may incur additional boarding charges for each extra day or part thereof.
If the owner cannot collect the pet on time, the clinic must be informed in advance.

Abandoned Pets
If a pet is not collected within 14 days after the agreed pickup date, and the owner has failed to respond despite reasonable attempts to contact them, the clinic reserves the right to transfer the pet to an animal welfare organization, arrange rehoming, or take any action permitted by applicable law. The owner remains responsible for all outstanding charges.

Agreement
I certify that all information provided is accurate and complete.
I have read, understood, and agree to abide by all terms and conditions stated above.

Owner's Signature: ________________________
Date: ________________________
`;

module.exports = { CONSENT_POLICY_TEXT };
