/* Browser-safe beta feedback configuration.
 * Set enabled to true and provide the HTTPS URL of the published Tally form.
 * questionIdField is optional and must match a hidden field configured in Tally.
 */
(function (global) {
  "use strict";

  global.AIML_FEEDBACK_CONFIG = Object.freeze({
    enabled: false,
    formUrl: "",
    questionIdField: ""
  });
})(window);
