// routes/bookings.js
'use strict';

const express = require('express');
const router = express.Router();

const supabase = require('../config/supabase');
const { authenticate, authorize } = require('../middleware/auth');
const { validate, sanitizeBody } = require('../middleware/validation');
const { NotFoundError, ValidationError, AuthorizationError } = require('../middleware/errors');
const { sendBookingConfirmationEmail, sendBookingAcceptedEmail } = require('../services/email.service');
const { logEvent } = require('../middleware/logger');

const createBookingSchema = {
  creatorId: { required: true, type: 'uuid' },
  campaignName: { required: true, type: 'string', minLength: 1, maxLength: 200 },
  dates: { required: true, type: 'dateArray' },
  budget: { required: true, type: 'number', min: 1, max: 10000000 },
  notes: { required: false, type: 'optionalString', maxLength: 2000 },
};

router.use(authenticate);

router.post(
  '/',
  sanitizeBody,
  validate(createBookingSchema),
  async (req, res, next) => {
    try {
      const { creatorId, campaignName, dates, budget, notes } = req.body;
      const advertiserId = req.user.id;

      if (advertiserId === creatorId) {
        return next(new ValidationError('Cannot create a booking with yourself'));
      }

      const { data: creator, error: creatorError } = await supabase
        .from('users')
        .select('id, email, role')
        .eq('id', creatorId)
        .maybeSingle();

      if (creatorError) {
        logEvent('error', 'Database error checking creator', {
          requestId: req.requestId,
          error: creatorError.message,
        });
        throw new Error(`Database error: ${creatorError.message}`);
      }

      if (!creator) {
        return next(new NotFoundError('Creator'));
      }

      if (creator.role !== 'creator') {
        return next(new ValidationError('Specified user is not a creator'));
      }

      const { data: advertiser, error: advertiserError } = await supabase
        .from('users')
        .select('id, email')
        .eq('id', advertiserId)
        .maybeSingle();

      if (advertiserError) {
        logEvent('error', 'Database error checking advertiser', {
          requestId: req.requestId,
          error: advertiserError.message,
        });
        throw new Error(`Database error: ${advertiserError.message}`);
      }

      const bookingRow = {
        creator_id: creatorId,
        advertiser_id: advertiserId,
        campaign_name: campaignName,
        dates: dates,
        budget: budget,
        status: 'pending',
      };

      if (notes) {
        bookingRow.notes = notes;
      }

      const { data: booking, error: insertError } = await supabase
        .from('bookings')
        .insert(bookingRow)
        .select('id, creator_id, advertiser_id, campaign_name, status, created_at')
        .single();

      if (insertError) {
        logEvent('error', 'Database error creating booking', {
          requestId: req.requestId,
          error: insertError.message,
        });
        throw new Error(`Database error: ${insertError.message}`);
      }

      logEvent('info', 'Booking created', {
        requestId: req.requestId,
        bookingId: booking.id,
        creatorId,
        advertiserId,
      });

      const creatorEmailResult = await sendBookingConfirmationEmail({
        to: creator.email,
        campaignName,
        dates,
        budget,
      });

      if (!creatorEmailResult.success) {
        logEvent('error', 'Failed to send booking confirmation to creator', {
          requestId: req.requestId,
          bookingId: booking.id,
          error: creatorEmailResult.error,
        });
      }

      if (advertiser && advertiser.email) {
        const advertiserEmailResult = await sendBookingConfirmationEmail({
          to: advertiser.email,
          campaignName,
          dates,
          budget,
        });

        if (!advertiserEmailResult.success) {
          logEvent('error', 'Failed to send booking confirmation to advertiser', {
            requestId: req.requestId,
            bookingId: booking.id,
            error: advertiserEmailResult.error,
          });
        }
      }

      return res.status(201).json({
        success: true,
        data: booking,
        requestId: req.requestId,
      });
    } catch (error) {
      logEvent('error', 'create-booking error', {
        requestId: req.requestId,
        error: error.message,
      });
      next(error);
    }
  }
);

router.patch(
  '/:id/accept',
  async (req, res, next) => {
    try {
      const { id: bookingId } = req.params;
      const userId = req.user.id;

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(bookingId)) {
        return next(new ValidationError('Invalid booking ID format'));
      }

      const { data: booking, error: fetchError } = await supabase
        .from('bookings')
        .select('id, creator_id, advertiser_id, campaign_name, status')
        .eq('id', bookingId)
        .maybeSingle();

      if (fetchError) {
        logEvent('error', 'Database error fetching booking', {
          requestId: req.requestId,
          error: fetchError.message,
        });
        throw new Error(`Database error: ${fetchError.message}`);
      }

      if (!booking) {
        return next(new NotFoundError('Booking'));
      }

      if (booking.creator_id !== userId) {
        return next(new AuthorizationError('Only the assigned creator can accept this booking'));
      }

      if (booking.status !== 'pending') {
        return next(new ValidationError(`Cannot accept a booking with status '${booking.status}'`));
      }

      const { data: updated, error: updateError } = await supabase
        .from('bookings')
        .update({
          status: 'accepted',
          updated_at: new Date().toISOString(),
        })
        .eq('id', bookingId)
        .eq('status', 'pending')
        .select('id, status, updated_at')
        .single();

      if (updateError) {
        logEvent('error', 'Database error accepting booking', {
          requestId: req.requestId,
          error: updateError.message,
        });
        throw new Error(`Database error: ${updateError.message}`);
      }

      if (!updated) {
        return next(new ValidationError('Booking was already modified. Please refresh.'));
      }

      logEvent('info', 'Booking accepted', {
        requestId: req.requestId,
        bookingId,
        creatorId: userId,
      });

      const { data: advertiser, error: advError } = await supabase
        .from('users')
        .select('email')
        .eq('id', booking.advertiser_id)
        .maybeSingle();

      if (!advError && advertiser && advertiser.email) {
        const emailResult = await sendBookingAcceptedEmail({
          to: advertiser.email,
          campaignName: booking.campaign_name,
        });

        if (!emailResult.success) {
          logEvent('error', 'Failed to send booking accepted email', {
            requestId: req.requestId,
            bookingId,
            error: emailResult.error,
          });
        }
      }

      return res.status(200).json({
        success: true,
        data: updated,
        requestId: req.requestId,
      });
    } catch (error) {
      logEvent('error', 'accept-booking error', {
        requestId: req.requestId,
        error: error.message,
      });
      next(error);
    }
  }
);

router.get(
  '/:id',
  async (req, res, next) => {
    try {
      const { id: bookingId } = req.params;
      const userId = req.user.id;

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(bookingId)) {
        return next(new ValidationError('Invalid booking ID format'));
      }

      const { data: booking, error: fetchError } = await supabase
        .from('bookings')
        .select('id, creator_id, advertiser_id, campaign_name, dates, budget, notes, status, created_at, updated_at')
        .eq('id', bookingId)
        .maybeSingle();

      if (fetchError) {
        logEvent('error', 'Database error fetching booking', {
          requestId: req.requestId,
          error: fetchError.message,
        });
        throw new Error(`Database error: ${fetchError.message}`);
      }

      if (!booking) {
        return next(new NotFoundError('Booking'));
      }

      if (booking.creator_id !== userId && booking.advertiser_id !== userId) {
        return next(new AuthorizationError('You do not have access to this booking'));
      }

      return res.status(200).json({
        success: true,
        data: booking,
        requestId: req.requestId,
      });
    } catch (error) {
      logEvent('error', 'get-booking error', {
        requestId: req.requestId,
        error: error.message,
      });
      next(error);
    }
  }
);

module.exports = router;
