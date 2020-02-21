odoo.define('asim_field_widget', function (require) {
"use strict";

var AbstractField = require('web.AbstractField');
var fieldRegistry = require('web.field_registry');
var concurrency = require('web.concurrency');
var basicFields = require('web.basic_fields');
var core = require('web.core');
var _t = core._t;
var qweb = core.qweb;
var values=0;

var colorField = AbstractField.extend({
    tag_template: "FieldMany2ManyTag",
    className: "o_field_many2manytags",
    supportedFieldTypes: ['many2many'],
    custom_events: _.extend({}, AbstractField.prototype.custom_events, {
        field_changed: '_onFieldChanged',
    }),
    events: _.extend({}, AbstractField.prototype.events, {
        'click .o_delete': '_onDeleteTag',
        
    }),
    fieldsToFetch: {
        display_name: {type: 'char'},
    },

    /**
     * @constructor
     */
    init: function () {
        this._super.apply(this, arguments);

        if (this.mode === 'edit') {
            this.className += ' o_input';
        }

        this.colorField = this.nodeOptions.color_field;
        this.hasDropdown = false;
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    activate: function () {
        return this.many2one ? this.many2one.activate() : false;
    },
    /**
     * @override
     * @returns {jQuery}
     */
    getFocusableElement: function () {
        return this.many2one ? this.many2one.getFocusableElement() : $();
    },
    /**
     * @override
     * @returns {boolean}
     */
    isSet: function () {
        return !!this.value && this.value.count;
    },
    /**
     * Reset the focus on this field if it was the origin of the onchange call.
     *
     * @override
     */
    reset: function (record, event) {
        this._super.apply(this, arguments);
        if (event && event.target === this) {
            this.activate();
        }
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {any} data
     */
    _addTag: function (data) {
        if (!_.contains(this.value.res_ids, data.id)) {
            this._setValue({
                operation: 'ADD_M2M',
                ids: data
            });
        }
    },
    /**
     * Get the QWeb rendering context used by the tag template; this computation
     * is placed in a separate function for other tags to override it.
     *
     * @private
     * @returns {Object}
     */
    _getRenderTagsContext: function () {
        var elements = this.value ? _.pluck(this.value.data, 'data') : [];
        return {
            colorField: this.colorField,
            elements: elements,
            hasDropdown: this.hasDropdown,
            readonly: this.mode === "readonly",
        };
    },
    /**
     * @private
     * @param {any} id
     */
    _removeTag: function (id) {
        var record = _.findWhere(this.value.data, {res_id: id});
        this._setValue({
            operation: 'FORGET',
            ids: [record.id],
        });
    },
    /**
     * @private
     */
    _renderEdit: function () {
        var self = this;
        this._renderTags();
        if (this.many2one) {
            this.many2one.destroy();
        }
        this.many2one = new FieldMany2One(this, this.name, this.record, {
            mode: 'edit',
            noOpen: true,
            viewType: this.viewType,
            attrs: this.attrs,
        });
        // to prevent the M2O to take the value of the M2M
        this.many2one.value = false;
        // to prevent the M2O to take the relational values of the M2M
        this.many2one.m2o_value = '';

        this.many2one._getSearchBlacklist = function () {
            return self.value.res_ids;
        };
        return this.many2one.appendTo(this.$el);
    },
    /**
     * @private
     */
    _renderReadonly: function () {
        this._renderTags();
    },
    /**
     * @private
     */
    _renderTags: function () {
        this.$el.html(qweb.render(this.tag_template, this._getRenderTagsContext()));
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {MouseEvent} event
     */
    _onDeleteTag: function (event) {
        event.preventDefault();
        event.stopPropagation();
        this._removeTag($(event.target).parent().data('id'));
    },
    /**
     * Controls the changes made in the internal m2o field.
     *
     * @private
     * @param {OdooEvent} ev
     */
    _onFieldChanged: function (ev) {
        if (ev.target !== this.many2one) {
            return;
        }
        ev.stopPropagation();
        var newValue = ev.data.changes[this.name];
        if (newValue) {
            this._addTag(newValue);
            this.many2one.reinitialize(false);
        }
    },
    /**
     * @private
     * @param {KeyboardEvent} ev
     */
    _onKeydown: function (ev) {
        if (ev.which === $.ui.keyCode.BACKSPACE && this.$('input').val() === "") {
            var $badges = this.$('.badge');
            if ($badges.length) {
                this._removeTag($badges.last().data('id'));
                return;
            }
        }
        this._super.apply(this, arguments);
    },
    /**
     * @private
     * @param {OdooEvent} event
     */
    _onQuickCreate: function (event) {
        this._quickCreate(event.data.value);
    },
});

var FieldMany2One = AbstractField.extend({
    supportedFieldTypes: ['many2one'],
    template: 'FieldMany2One',
    custom_events: _.extend({}, AbstractField.prototype.custom_events, {
        'closed_unset': '_onDialogClosedUnset',
        'field_changed': '_onFieldChanged',
        'quick_create': '_onQuickCreate',
        'search_create_popup': '_onSearchCreatePopup',
    }),
    events: _.extend({}, AbstractField.prototype.events, {
        'click input': '_onInputClick',
        'focusout input': '_onInputFocusout',
        'keyup input': '_onInputKeyup',
        'click .o_external_button': '_onExternalButtonClick',
        'click': '_onClick',
    }),
    AUTOCOMPLETE_DELAY: 200,

    /**
     * @override
     * @param {boolean} [options.noOpen=false] if true, there is no external
     *   button to open the related record in a dialog
     */
    init: function (parent, name, record, options) {
        this._super.apply(this, arguments);
        this.limit = values.length;
        this.orderer = new concurrency.DropMisordered();

        // should normally also be set, except in standalone M20
        this.can_create = ('can_create' in this.attrs ? JSON.parse(this.attrs.can_create) : true) &&
            !this.nodeOptions.no_create;
        this.can_write = 'can_write' in this.attrs ? JSON.parse(this.attrs.can_write) : true;

        this.nodeOptions = _.defaults(this.nodeOptions, {
            quick_create: true,
        });
        this.noOpen = 'noOpen' in (options || {}) ? options.noOpen : this.nodeOptions.no_open;
        this.m2o_value = this._formatValue(this.value);
        // 'recordParams' is a dict of params used when calling functions
        // 'getDomain' and 'getContext' on this.record
        this.recordParams = {fieldName: this.name, viewType: this.viewType};
        // We need to know if the widget is dirty (i.e. if the user has changed
        // the value, and those changes haven't been acknowledged yet by the
        // environment), to prevent erasing that new value on a reset (e.g.
        // coming by an onchange on another field)
        this.isDirty = false;
        this.lastChangeEvent = undefined;

        // List of autocomplete sources
        this._autocompleteSources = [];
        // Add default search method for M20 (name_search)
        this._addAutocompleteSource(this._search, {placeholder: _t('Loading...'), order: 1});

        // use a DropPrevious to properly handle related record quick creations,
        // and store a createDef to be able to notify the environment that there
        // is pending quick create operation
        this.dp = new concurrency.DropPrevious();
        this.createDef = undefined;
    },
    start: function () {
        // booleean indicating that the content of the input isn't synchronized
        // with the current m2o value (for instance, the user is currently
        // typing something in the input, and hasn't selected a value yet).
        this.floating = false;

        this.$input = this.$('input');
        this.$external_button = this.$('.o_external_button');
        return this._super.apply(this, arguments);
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * Override to make the caller wait for potential ongoing record creation.
     * This ensures that the correct many2one value is set when the main record
     * is saved.
     *
     * @override
     * @returns {Deferred} resolved as soon as there is no longer record being
     *   (quick) created
     */
    commitChanges: function () {
        return $.when(this.createDef);
    },
    /**
     * @override
     * @returns {jQuery}
     */
    getFocusableElement: function () {
        return this.mode === 'edit' && this.$input || this.$el;
    },
    /**
     * TODO
     */
    reinitialize: function (value) {
        this.isDirty = false;
        this.floating = false;
        return this._setValue(value);
    },
    /**
     * Re-renders the widget if it isn't dirty. The widget is dirty if the user
     * changed the value, and that change hasn't been acknowledged yet by the
     * environment. For example, another field with an onchange has been updated
     * and this field is updated before the onchange returns. Two '_setValue'
     * are done (this is sequential), the first one returns and this widget is
     * reset. However, it has pending changes, so we don't re-render.
     *
     * @override
     */
    reset: function (record, event) {
        this._reset(record, event);
        if (!event || event === this.lastChangeEvent) {
            this.isDirty = false;
        }
        if (this.isDirty) {
            return $.when();
        } else {
            return this._render();
        }
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Add a source to the autocomplete results
     *
     * @param {function} method : A function that returns a list of results. If async source, the function should return a promise
     * @param {Object} params : Parameters containing placeholder/validation/order
     * @private
     */
    _addAutocompleteSource: function (method, params) {
        this._autocompleteSources.push({
            method: method,
            placeholder: (params.placeholder ? _t(params.placeholder) : _t('Loading...')) + '<i class="fa fa-spinner fa-spin pull-right"></i>' ,
            validation: params.validation,
            loading: false,
            order: params.order || 999
        });

        this._autocompleteSources = _.sortBy(this._autocompleteSources, 'order');
    },
    /**
     * @private
     */
    _bindAutoComplete: function () {
        var self = this;
        // avoid ignoring autocomplete="off" by obfuscating placeholder, see #30439
        if ($.browser.chrome && this.$input.attr('placeholder')) {
            this.$input.attr('placeholder', function (index, val) {
                return val.split('').join('\ufeff');
            });
        }
        this.$input.autocomplete({
            source: function (req, resp) {
                _.each(self._autocompleteSources, function (source) {
                    // Resets the results for this source
                    source.results = [];

                    // Check if this source should be used for the searched term
                    if (!source.validation || source.validation.call(self, req.term)) {
                        source.loading = true;

                        // Wrap the returned value of the source.method with $.when.
                        // So event if the returned value is not async, it will work
                        $.when(source.method.call(self, req.term)).then(function (results) {
                            source.results = results;
                            source.loading = false;
                            resp(self._concatenateAutocompleteResults());
                        });
                    }
                });
            },
            select: function (event, ui) {
                // we do not want the select event to trigger any additional
                // effect, such as navigating to another field.
                event.stopImmediatePropagation();
                event.preventDefault();

                var item = ui.item;
                self.floating = false;
                if (item.id) {
                    self.reinitialize({id: item.id, display_name: item.name});
                } else if (item.action) {
                    item.action();
                }
                return false;
            },
            focus: function (event) {
                event.preventDefault(); // don't automatically select values on focus
            },
            close: function (event) {
                // it is necessary to prevent ESC key from propagating to field
                // root, to prevent unwanted discard operations.
                if (event.which === $.ui.keyCode.ESCAPE) {
                    event.stopPropagation();
                }
            },
            autoFocus: true,
            html: true,
            minLength: 0,
            delay: this.AUTOCOMPLETE_DELAY,
        });
        this.$input.autocomplete("option", "position", { my : "left top", at: "left bottom" });
        this.autocomplete_bound = true;
    },
    /**
     * Concatenate async results for autocomplete.
     *
     * @returns {Array}
     * @private
     */
    _concatenateAutocompleteResults: function () {
        var results = [];
        _.each(this._autocompleteSources, function (source) {
            if (source.results && source.results.length) {
                results = results.concat(source.results);
            } else if (source.loading) {
                results.push({
                    label: source.placeholder
                });
            }
        });
        return results;
    },
    /**
     * @private
     * @param {string} [name]
     * @returns {Object}
     */
    _createContext: function (name) {
        var tmp = {};
        var field = this.nodeOptions.create_name_field;
        if (field === undefined) {
            field = "name";
        }
        if (field !== false && name && this.nodeOptions.quick_create !== false) {
            tmp["default_" + field] = name;
        }
        return tmp;
    },
    /**
     * @private
     * @returns {Array}
     */
    _getSearchBlacklist: function () {
        return [];
    },
    /**
    * Returns the display_name from a string which contains it but was altered
    * as a result of the show_address option using a horrible hack.
    *
    * @private
    * @param {string} value
    * @returns {string} display_name without show_address mess
    */
    _getDisplayName: function (value) {
        return value.split('\n')[0];
    },
    /**
     * Listens to events 'field_changed' to keep track of the last event that
     * has been trigerred. This allows to detect that all changes have been
     * acknowledged by the environment.
     *
     * @param {OdooEvent} event 'field_changed' event
     */
    _onFieldChanged: function (event) {
        this.lastChangeEvent = event;
    },
    /**
     * @private
     * @param {string} name
     * @returns {Deferred} resolved after the name_create or when the slowcreate
     *                     modal is closed.
     */
    _quickCreate: function (name) {
        var self = this;
        var def = $.Deferred();
        this.createDef = this.createDef || $.Deferred();
        // called when the record has been quick created, or when the dialog has
        // been closed (in the case of a 'slow' create), meaning that the job is
        // done
        var createDone = function () {
            def.resolve();
            self.createDef.resolve();
            self.createDef = undefined;
        };
        // called if the quick create is disabled on this many2one, or if the
        // quick creation failed (probably because there are mandatory fields on
        // the model)
        var slowCreate = function () {
            var dialog = self._searchCreatePopup("form", false, self._createContext(name));
            dialog.on('closed', self, createDone);
        };
        if (this.nodeOptions.quick_create) {
            var nameCreateDef = this._rpc({
                model: this.field.relation,
                method: 'name_create',
                args: [name],
                context: this.record.getContext(this.recordParams),
            }).fail(function (error, ev) {
                ev.preventDefault();
                slowCreate();
            });
            this.dp.add(nameCreateDef)
                .then(function (result) {
                    if (self.mode === "edit") {
                        self.reinitialize({id: result[0], display_name: result[1]});
                    }
                    createDone();
                })
                .fail(def.reject.bind(def));
        } else {
            slowCreate();
        }
        return def;
    },
    /**
     * @private
     */
    _renderEdit: function () {
        var value = this.m2o_value;

        // this is a stupid hack necessary to support the always_reload flag.
        // the field value has been reread by the basic model.  We use it to
        // display the full address of a patner, separated by \n.  This is
        // really a bad way to do it.  Now, we need to remove the extra lines
        // and hope for the best that noone tries to uses this mechanism to do
        // something else.
        if (this.nodeOptions.always_reload) {
            value = this._getDisplayName(value);
        }
        this.$input.val(value);

        
        if (!this.autocomplete_bound) {
            this._bindAutoComplete();
        }
        this._updateExternalButton();
    },
    /**
     * @private
     */
    _renderReadonly: function () {
        var value = _.escape((this.m2o_value || "").trim()).split("\n").join("<br/>");
        this.$el.html(value);
        if (!this.noOpen && this.value) {
            this.$el.attr('href', _.str.sprintf('#id=%s&model=%s', this.value.res_id, this.field.relation));
            this.$el.addClass('o_form_uri');
        }
    },
    /**
     * @private
     */
    _reset: function () {
        this._super.apply(this, arguments);
        this.floating = false;
        this.m2o_value = this._formatValue(this.value);
    },
    /**
     * Executes a name_search and process its result.
     *
     * @private
     * @param {string} search_val
     * @returns {Deferred}
     */
    _search: function (search_val) {
        var self = this;
        var def = $.Deferred();
        this.orderer.add(def);

        var context = this.record.getContext(this.recordParams);
        var domain = this.record.getDomain(this.recordParams);

        // Add the additionalContext
        _.extend(context, this.additionalContext);

        var blacklisted_ids = this._getSearchBlacklist();
        if (blacklisted_ids.length > 0) {
            domain.push(['id', 'not in', blacklisted_ids]);
        }

        this._rpc({
            model: this.field.relation,
            method: "name_search",
            kwargs: {
                name: search_val,
                args: domain,
                operator: "ilike",
                context: context,
            }})
            .then(function (result) {
                // possible selections for the m2o
                values = _.map(result, function (x) {
                    x[1] = self._getDisplayName(x[1]);
                    return {
                        label: _.str.escapeHTML(x[1].trim()) || data.noDisplayContent,
                        value: x[1],
                        name: x[1],
                        id: x[0],
                    };
                });

                // search more... if more results than limit
             /*   if (values.length > self.limit) {
                    values = values.slice(0, self.limit);
                    values.push({
                        label: _t("Search More..."),
                        action: function () {
                            self._rpc({
                                    model: self.field.relation,
                                    method: 'name_search',
                                    kwargs: {
                                        name: search_val,
                                        args: domain,
                                        operator: "ilike",
                                        limit: 160,
                                        context: context,
                                    },
                                })
                                .then(self._searchCreatePopup.bind(self, "search"));
                        },
                        classname: 'o_m2o_dropdown_option',
                    });
                }
                var create_enabled = self.can_create && !self.nodeOptions.no_create;
                // quick create
                var raw_result = _.map(result, function (x) { return x[1]; });
               /* if (create_enabled && !self.nodeOptions.no_quick_create &&
                    search_val.length > 0 && !_.contains(raw_result, search_val)) {
                    values.push({
                        label: _.str.sprintf(_t('Create "<strong>%s</strong>"'),
                            $('<span />').text(search_val).html()),
                        action: self._quickCreate.bind(self, search_val),
                        classname: 'o_m2o_dropdown_option'
                    });
                }*/
                // create and edit ...
              /*  if (create_enabled && !self.nodeOptions.no_create_edit) {
                    var createAndEditAction = function () {
                        // Clear the value in case the user clicks on discard
                        self.$('input').val('');
                        return self._searchCreatePopup("form", false, self._createContext(search_val));
                    };
                    values.push({
                        label: _t("Create and Edit..."),
                        action: createAndEditAction,
                        classname: 'o_m2o_dropdown_option',
                    });
                } else */
                if (values.length === 0) {
                    values.push({
                        label: _t("No results to show..."),
                    });
                }

                def.resolve(values);
            });

        return def;
    },
    /**
     * all search/create popup handling
     *
     * @private
     * @param {any} view
     * @param {any} ids
     * @param {any} context
     */
    _searchCreatePopup: function (view, ids, context) {
        var self = this;
        return new dialogs.SelectCreateDialog(this, _.extend({}, this.nodeOptions, {
            res_model: this.field.relation,
            domain: this.record.getDomain({fieldName: this.name}),
            context: _.extend({}, this.record.getContext(this.recordParams), context || {}),
            title: (view === 'search' ? _t("Search: ") : _t("Create: ")) + this.string,
            initial_ids: ids ? _.map(ids, function (x) { return x[0]; }) : undefined,
            initial_view: view,
            disable_multiple_selection: true,
            no_create: !self.can_create,
            on_selected: function (records) {
                self.reinitialize(records[0]);
                self.activate();
            }
        })).open();
    },
    /**
     * @private
     */
    _updateExternalButton: function () {
        var has_external_button = !this.noOpen && !this.floating && this.isSet();
        this.$external_button.toggle(has_external_button);
        this.$el.toggleClass('o_with_button', has_external_button); // Should not be required anymore but kept for compatibility
    },


    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {MouseEvent} event
     */
    _onClick: function (event) {
        var self = this;
        if (this.mode === 'readonly' && !this.noOpen) {
            event.preventDefault();
            event.stopPropagation();
            this._rpc({
                    model: this.field.relation,
                    method: 'get_formview_action',
                    args: [[this.value.res_id]],
                    context: this.record.getContext(this.recordParams),
                })
                .then(function (action) {
                    self.trigger_up('do_action', {action: action});
                });
        }
    },

    /**
     * Reset the input as dialog has been closed without m2o creation.
     *
     * @private
     */
    _onDialogClosedUnset: function () {
        this.isDirty = false;
        this.floating = false;
        this._render();
    },
    /**
     * @private
     */
    _onExternalButtonClick: function () {
        if (!this.value) {
            this.activate();
            return;
        }
        var self = this;
        var context = this.record.getContext(this.recordParams);
        this._rpc({
                model: this.field.relation,
                method: 'get_formview_id',
                args: [[this.value.res_id]],
                context: context,
            })
            .then(function (view_id) {
                new dialogs.FormViewDialog(self, {
                    res_model: self.field.relation,
                    res_id: self.value.res_id,
                    context: context,
                    title: _t("Open: ") + self.string,
                    view_id: view_id,
                    readonly: !self.can_write,
                    on_saved: function (record, changed) {
                        if (changed) {
                            self._setValue(self.value.data, {forceChange: true});
                            self.trigger_up('reload', {db_id: self.value.id});
                        }
                    },
                }).open();
            });
    },
    /**
     * @private
     */
    _onInputClick: function () {
        if (this.$input.autocomplete("widget").is(":visible")) {
            this.$input.autocomplete("close");
        } else if (this.floating) {
            this.$input.autocomplete("search"); // search with the input's content
        } else {
            this.$input.autocomplete("search", ''); // search with the empty string
        }
    },
    /**
     * @private
     */
    _onInputFocusout: function () {
        if (this.can_create && this.floating) {
            new M2ODialog(this, this.string, this.$input.val()).open();
        }
    },
    /**
     * @private
     *
     * @param {OdooEvent} ev
     */
    _onInputKeyup: function (ev) {
        if (ev.which === $.ui.keyCode.ENTER || ev.which === $.ui.keyCode.TAB) {
            // If we pressed enter or tab, we want to prevent _onInputFocusout from
            // executing since it would open a M2O dialog to request
            // confirmation that the many2one is not properly set.
            // It's a case that is already handled by the autocomplete lib.
            return;
        }
        this.isDirty = true;
        if (this.$input.val() === "") {
            this.reinitialize(false);
        } else if (this._getDisplayName(this.m2o_value) !== this.$input.val()) {
            this.floating = true;
            this._updateExternalButton();
        }
    },
    /**
     * @override
     * @private
     */
    _onKeydown: function () {
        this.floating = false;
        this._super.apply(this, arguments);
    },
    /**
     * Stops the left/right navigation move event if the cursor is not at the
     * start/end of the input element. Stops any navigation move event if the
     * user is selecting text.
     *
     * @private
     * @param {OdooEvent} ev
     */
    _onNavigationMove: function (ev) {
        // TODO Maybe this should be done in a mixin or, better, the m2o field
        // should be an InputField (but this requires some refactoring).
        basicFields.InputField.prototype._onNavigationMove.apply(this, arguments);
        if (this.mode === 'edit' && $(this.$input.autocomplete('widget')).is(':visible')) {
            ev.stopPropagation();
        }
    },
    /**
     * @private
     * @param {OdooEvent} event
     */
    _onQuickCreate: function (event) {
        this._quickCreate(event.data.value);
    },
    /**
     * @private
     * @param {OdooEvent} event
     */
    _onSearchCreatePopup: function (event) {
        var data = event.data;
        this._searchCreatePopup(data.view_type, false, this._createContext(data.value));
    },
});

var asimList = colorField.extend({
    events: _.extend({}, colorField.prototype.events, {
        'click .dropdown-toggle': '_onOpenColorPicker',
        'mousedown .o_colorpicker a': '_onUpdateColor',
        'mousedown .o_colorpicker .o_hide_in_kanban': '_onUpdateColor',
    }),
    /**
     * @override
     */
    init: function () {
        this._super.apply(this, arguments);

        this.hasDropdown = !!this.colorField;
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {MouseEvent} ev
     */
    _onOpenColorPicker: function (ev) {
        ev.preventDefault();
        var tagID = $(ev.currentTarget).parent().data('id');
        var tagColor = $(ev.currentTarget).parent().data('color');
        var tag = _.findWhere(this.value.data, { res_id: tagID });
        if (tag && this.colorField in tag.data) { // if there is a color field on the related model
            this.$color_picker = $(qweb.render('FieldMany2ManyTag.colorpicker', {
                'widget': this,
                'tag_id': tagID,
            }));

            $(ev.currentTarget).after(this.$color_picker);
            this.$color_picker.dropdown();
            this.$color_picker.attr("tabindex", 1).focus();
            if (!tagColor) {
                this.$('.custom-checkbox input').prop('checked', true);
            }
        }
    },
    /**
     * Update color based on target of ev
     * either by clicking on a color item or
     * by toggling the 'Hide in Kanban' checkbox.
     *
     * @private
     * @param {MouseEvent} ev
     */
    _onUpdateColor: function (ev) {
        ev.preventDefault();
        var $target = $(ev.currentTarget);
        var color = $target.data('color');
        var id = $target.data('id');
        var $tag = this.$(".badge[data-id='" + id + "']");
        var currentColor = $tag.data('color');
        var changes = {};

        if ($target.is('.o_hide_in_kanban')) {
            var $checkbox = $('.o_hide_in_kanban .custom-checkbox input');
            $checkbox.prop('checked', !$checkbox.prop('checked')); // toggle checkbox
            this.prevColors = this.prevColors ? this.prevColors : {};
            if ($checkbox.is(':checked')) {
                this.prevColors[id] = currentColor;
            } else {
                color = this.prevColors[id] ? this.prevColors[id] : 1;
            }
        } else if ($target.is('[class^="o_tag_color"]')) { // $target.is('o_tag_color_')
            if (color === currentColor) { return; }
        }

        changes[this.colorField] = color;

        this.trigger_up('field_changed', {
            dataPointID: _.findWhere(this.value.data, {res_id: id}).id,
            changes: changes,
            force_save: true,
        });
    },
});



fieldRegistry.add('Asim2many', asimList);

return {
    asimList: asimList,
};
});
