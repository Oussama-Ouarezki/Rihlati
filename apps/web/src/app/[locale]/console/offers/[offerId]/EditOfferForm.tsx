'use client';

import type { OfferForAgency } from '@rihlati/shared';
import { updateOffer } from '@/lib/offer-actions';
import { OfferForm } from '@/components/console/OfferForm';

/**
 * Binds the offer's id and kind into the update action.
 *
 * A thin client wrapper because `.bind()` on a server action has to happen
 * where the action is used, and OfferForm needs the already-bound function.
 * The kind is fixed here — changing it would invalidate every stored
 * attribute, which is why `updateOfferSchema` omits it entirely.
 */
export function EditOfferForm(props: { offer: OfferForAgency }) {
  const action = updateOffer.bind(null, props.offer.id, props.offer.kind);
  return <OfferForm action={action} offer={props.offer} kind={props.offer.kind} />;
}
