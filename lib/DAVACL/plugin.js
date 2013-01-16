/*
 * @package jsDAV
 * @subpackage DAVACL
 * @copyright Copyright(c) 2013 Mike de Boer. <info AT mikedeboer DOT nl>
 * @author Mike de Boer <info AT mikedeboer DOT nl>
 * @license http://github.com/mikedeboer/jsDAV/blob/master/LICENSE MIT License
 */
"use strict";

var jsDAV_ServerPlugin = require("./../DAV/plugin");

var Util = require("./../shared/util");
var Exc = require("./../shared/exceptions");

var Async = require("asyncjs");

/**
 * jsDAV ACL Plugin
 *
 * This plugin provides functionality to enforce ACL permissions.
 * ACL is defined in RFC3744.
 *
 * In addition it also provides support for the {DAV:}current-user-principal
 * property, defined in RFC5397 and the {DAV:}expand-property report, as
 * defined in RFC3253.
 */
var jsDAVACL_Plugin = module.exports = jsDAV_ServerPlugin.extend({
    /**
     * Recursion constants
     *
     * This only checks the base node
     */
    R_PARENT: 1,

    /**
     * Recursion constants
     *
     * This checks every node in the tree
     */
    R_RECURSIVE: 2,

    /**
     * Recursion constants
     *
     * This checks every parentnode in the tree, but not leaf-nodes.
     */
    R_RECURSIVEPARENTS: 3,

    /**
     * Reference to server object.
     *
     * @var jsDAV_Handler
     */
    handler: null,

    /**
     * List of urls containing principal collections.
     * Modify this if your principals are located elsewhere.
     *
     * @var array
     */
    principalCollectionSet: [
        "principals"
    ],

    /**
     * By default ACL is only enforced for nodes that have ACL support (the
     * ones that implement IACL). For any other node, access is
     * always granted.
     *
     * To override this behaviour you can turn this setting off. This is useful
     * if you plan to fully support ACL in the entire tree.
     *
     * @var bool
     */
    allowAccessToNodesWithoutACL: true,

    /**
     * By default nodes that are inaccessible by the user, can still be seen
     * in directory listings (PROPFIND on parent with Depth: 1)
     *
     * In certain cases it's desirable to hide inaccessible nodes. Setting this
     * to true will cause these nodes to be hidden from directory listings.
     *
     * @var bool
     */
    hideNodesFromListings: false,

    /**
     * This string is prepended to the username of the currently logged in
     * user. This allows the plugin to determine the principal path based on
     * the username.
     *
     * @var string
     */
    defaultUsernamePath: "principals",

    /**
     * This list of properties are the properties a client can search on using
     * the {DAV:}principal-property-search report.
     *
     * The keys are the property names, values are descriptions.
     *
     * @var Object
     */
    principalSearchPropertySet: {
        "{DAV:}displayname": "Display name",
        "{http://ajax.org/2005/aml}email-address": "Email address"
    },

    /**
     * Any principal uri's added here, will automatically be added to the list
     * of ACL's. They will effectively receive {DAV:}all privileges, as a
     * protected privilege.
     *
     * @var array
     */
    adminPrincipals: [],

    /**
     * Returns a list of features added by this plugin.
     *
     * This list is used in the response of a HTTP OPTIONS request.
     *
     * @return array
     */
    getFeatures: function() {
        return ["access-control", "calendarserver-principal-property-search"];
    },

    /**
     * Returns a list of available methods for a given url
     *
     * @param string uri
     * @return array
     */
    getHTTPMethods: function(uri) {
        return ["ACL"];
    },

    /**
     * Returns a plugin name.
     *
     * Using this name other plugins will be able to access other plugins
     * using jsDAV_Server#getPlugin
     *
     * @return string
     */
    getPluginName: function() {
        return "acl";
    },

    /**
     * Returns a list of reports this plugin supports.
     *
     * This will be used in the {DAV:}supported-report-set property.
     * Note that you still need to subscribe to the 'report' event to actually
     * implement them
     *
     * @param string uri
     * @return array
     */
    getSupportedReportSet: function(uri) {
        return [
            "{DAV:}expand-property",
            "{DAV:}principal-property-search",
            "{DAV:}principal-search-property-set",
        ];
    },

    /**
     * Checks if the current user has the specified privilege(s).
     *
     * You can specify a single privilege, or a list of privileges.
     * This method will throw an exception if the privilege is not available
     * and return true otherwise.
     *
     * @param string uri
     * @param array|string privileges
     * @param number recursion
     * @throws jsDAV_Exception_NeedPrivileges
     * @return bool
     */
    checkPrivileges: function(uri, privileges, recursion, callback) {
        if (!Array.isArray(privileges))
            privileges = [privileges];

        recursion = recursion || this.R_PARENT;
        var self = this;

        this.getCurrentUserPrivilegeSet(uri, function(err, acl) {
            if (err)
                return callback(err);

            if (acl) {
                if (self.allowAccessToNodesWithoutACL)
                    return callback(null, true);
                else
                    return callback(new Exc.NeedPrivileges(uri, privileges), false);
            }

            var failed = privileges.filter(function(priv) {
                return acl.indexOf(priv) === -1;
            });

            if (failed.length)
                return callback(new Exc.NeedPrivileges(uri, failed), false);

            return true;
        });
    },

    /**
     * Returns the standard users' principal.
     *
     * This is one authorative principal url for the current user.
     * This method will return null if the user wasn't logged in.
     *
     * @return string|null
     */
    getCurrentUserPrincipal: function(callback) {
        var authPlugin = this.handler.plugins.auth;

        if (!authPlugin)
            return callback();
        /** @var authPlugin jsDAV_Auth_Plugin */

        var self = this;
        authPlugin.getCurrentUser(function(err, userName) {
            if (err)
                return callback(err);
            if (!userName)
                return callback();
            callback(null, self.defaultUsernamePath + "/" + userName);
        });
    },


    /**
     * Returns a list of principals that's associated to the current
     * user, either directly or through group membership.
     *
     * @return array
     */
    getCurrentUserPrincipals: function(callback) {
        var self = this;
        this.getCurrentUserPrincipal(function(err, currentUser) {
            if (err)
                return callback(err);
            if (!currentUser)
                return callback(null, []);

            self.getPrincipalMembership(currentUser, function(err, membership) {
                if (err)
                    return callback(err);
                callback(null, [currentUser].concat(membership));
            });
        });
    },

    /**
     * This array holds a cache for all the principals that are associated with
     * a single principal.
     *
     * @var array
     */
    principalMembershipCache: [],

    /**
     * Returns all the principal groups the specified principal is a member of.
     *
     * @param string principal
     * @return array
     */
    getPrincipalMembership: function(mainPrincipal, callback) {
        // First check our cache
        if (this.principalMembershipCache[mainPrincipal])
            return callback(null, this.principalMembershipCache[mainPrincipal]);

        var check = [mainPrincipal];
        var principals = [];
        var self = this;

        function checkNext() {
            var principal = check.shift();
            if (!principal)
                return checkedAll();

            self.handler.getNodeForPath(principal, function(err, node) {
                if (err)
                    return checkedAll(err);

                if (node.hasFeature(jsDAVACL_iPrincipal)) {
                    node.getGroupMembership(function(err, memberships) {
                        if (err)
                            return checkedAll(err);

                        memberships.forEach(function(groupMember) {
                            if (pricipals.indexOf(groupMember) === -1) {
                                check.push(groupMember);
                                principals.push(groupMember);
                            }
                        });
                        checkNext();
                    });
                }
                else
                    checkNext();
            });
        }

        function checkedAll(err) {
            if (err)
                return callback(err, []);

            // Store the result in the cache
            self.principalMembershipCache[mainPrincipal] = principals;

            callback(err, principals);
        }

        checkNext();
    },

    /**
     * Returns the supported privilege structure for this ACL plugin.
     *
     * See RFC3744 for more details. Currently we default on a simple,
     * standard structure.
     *
     * You can either get the list of privileges by a uri (path) or by
     * specifying a Node.
     *
     * @param string|DAV\INode node
     * @return array
     */
    getSupportedPrivilegeSet: function(node, callback) {
        if (!node.hasFeature) {
            this.handler.getNodeForPath(node, function(err, n) {
                if (err)
                    return callback(err);
                node = n;
                gotNode();
            });
        }
        else
            gotNode();

        var self = this;

        function gotNode() {
            if (node.getSupportedPrivilegeSet) {
                node.getSupportedPrivilegeSet(function(err, result) {
                    if (err)
                        return callback(err);
                    callback(null, result || self.getDefaultSupportedPrivilegeSet());
                });
            }
            else
                callback(null, self.getDefaultSupportedPrivilegeSet());
        }
    },

    /**
     * Returns a fairly standard set of privileges, which may be useful for
     * other systems to use as a basis.
     *
     * @return array
     */
    getDefaultSupportedPrivilegeSet: function() {
        return {
            "privilege"  : "{DAV:}all",
            "abstract"   : true,
            "aggregates" : [
                {
                    "privilege"  : "{DAV:}read",
                    "aggregates" : [
                        {
                            "privilege" : "{DAV:}read-acl",
                            "abstract"  : true
                        },
                        {
                            "privilege" : "{DAV:}read-current-user-privilege-set",
                            "abstract"  : true
                        }
                    ]
                }, // {DAV:}read
                {
                    "privilege"  : "{DAV:}write",
                    "aggregates" : [
                        {
                            "privilege" : "{DAV:}write-acl",
                            "abstract"  : true
                        },
                        {
                            "privilege" : "{DAV:}write-properties",
                            "abstract"  : true
                        },
                        {
                            "privilege" : "{DAV:}write-content",
                            "abstract"  : true
                        },
                        {
                            "privilege" : "{DAV:}bind",
                            "abstract"  : true
                        },
                        {
                            "privilege" : "{DAV:}unbind",
                            "abstract"  : true
                        },
                        {
                            "privilege" : "{DAV:}unlock",
                            "abstract"  : true
                        }
                    ]
                } // {DAV:}write
            ]
        }; // {DAV:}all
    },

    /**
     * Returns the supported privilege set as a flat list
     *
     * This is much easier to parse.
     *
     * The returned list will be index by privilege name.
     * The value is a struct containing the following properties:
     *   - aggregates
     *   - abstract
     *   - concrete
     *
     * @param string|DAV\INode node
     * @return array
     */
    getFlatPrivilegeSet: function(node, callback) {
        var self = this;

        this.getSupportedPrivilegeSet(node, function(err, privs) {
            if (err)
                return callback(err);

            var flat = [];

            // Traverses the privilege set tree for reordering
            function getFPSTraverse(priv, isConcrete, flat) {
                myPriv = {
                    "privilege" : priv.privilege,
                    "abstract" : !!priv.abstract && priv.abstract,
                    "aggregates" : [],
                    "concrete" : !!priv.abstract && priv.abstract ? isConcrete : priv.privilege
                };

                if (priv.aggregates) {
                    priv.aggregates.forEach(function(subPriv) {
                        myPriv.aggregates.push(subPriv.privilege);
                    });
                }

                flat[priv.privilege] = myPriv;

                if (priv.aggregates) {
                    priv.aggregates.forEach(function(subPriv) {
                        getFPSTraverse(subPriv, myPriv.concrete, flat);
                    });
                }
            }

            callback(null, getFPSTraverse(privs, null, []));
        });
    },

    /**
     * Returns the full ACL list.
     *
     * Either a uri or a DAV\INode may be passed.
     *
     * null will be returned if the node doesn't support ACLs.
     *
     * @param string|DAV\INode node
     * @return array
     */
    getACL: function(node, callback) {
        if (typeof node == "string") {
            node = this.handler.getNodeForPath(node, function(err, n) {
                if (err)
                    return callback(err);
                node = n;
                gotNode();
            });
        }
        else
            gotNode();

        var self = this;

        function gotNode() {
            if (!node.hasFeature(jsDAVACL_iACL))
                return callback();

            node.getACL(function(err, acl) {
                if (err)
                    return callback(err);

                self.adminPrincipals.forEach(function(adminPrincipal) {
                    acl.push({
                        "principal" : adminPrincipal,
                        "privilege" : "{DAV:}all",
                        "protected" : true
                    });
                });
                return callback(null, acl);
            });
        }
    },

    /**
     * Returns a list of privileges the current user has
     * on a particular node.
     *
     * Either a uri or a jsDAV_iNode may be passed.
     *
     * null will be returned if the node doesn't support ACLs.
     *
     * @param string|jsDAV_iNode node
     * @return array
     */
    getCurrentUserPrivilegeSet: function(node, callback) {
        if (typeof node == "string") {
            node = this.handler.getNodeForPath(node, function(err, n) {
                if (err)
                    return callback(err);
                node = n;
                gotNode();
            });
        }
        else
            gotNode();

        var self = this;

        function gotNode() {
            self.getACL(node, function(err, acl) {
                if (err)
                    return callback(err);
                if (!acl)
                    return callback();

                self.getCurrentUserPrincipals(function(err, principals) {
                    if (err)
                        return callback(err);

                    var collected = [];

                    acl.forEach(function(ace) {
                        var principal = ace.principal;
                        switch (principal) {
                            case "{DAV:}owner" :
                                var owner = node.getOwner();
                                if (owner && principals.indexOf(owner) > -1)
                                    collected.push(ace);
                                break;
                            // 'all' matches for every user
                            case "{DAV:}all" :
                            // 'authenticated' matched for every user that's logged in.
                            // Since it's not possible to use ACL while not being logged
                            // in, this is also always true.
                            case "{DAV:}authenticated" :
                                collected.push(ace);
                                break;
                            // 'unauthenticated' can never occur either, so we simply
                            // ignore these.
                            case "{DAV:}unauthenticated" :
                                break;
                            default :
                                if (principals.indexOf(ace.principal) > -1)
                                    collected.push(ace);
                                break;
                        }
                    });

                    // Now we deduct all aggregated privileges.
                    self.getFlatPrivilegeSet(node, function(err, flat) {
                        if (err)
                            return callback(err);

                        var current;
                        var collected2 = [];
                        while (collected.length) {
                            current = collected.pop();
                            collected2.push(current.privilege);

                            flat[current["privilege"]]["aggregates"].forEach(function(subPriv) {
                                collected2.push(subPriv);
                                collected.push(flat[subPriv]);
                            });
                        }

                        callback(null, Util.makeUnique(collected2));
                    });
                });
            });
        }
    },

    /**
     * Principal property search
     *
     * This method can search for principals matching certain values in
     * properties.
     *
     * This method will return a list of properties for the matched properties.
     *
     * @param array searchProperties    The properties to search on. This is a
     *                                   key-value list. The keys are property
     *                                   names, and the values the strings to
     *                                   match them on.
     * @param array requestedProperties This is the list of properties to
     *                                   return for every match.
     * @param string collectionUri      The principal collection to search on.
     *                                   If this is ommitted, the standard
     *                                   principal collection-set will be used.
     * @return array     This method returns an array structure similar to
     *                  Sabre\DAV\Server::getPropertiesForPath. Returned
     *                  properties are index by a HTTP status code.
     *
     */
    principalSearch: function(searchProperties, requestedProperties, collectionUri) {
        var uris;
        if (collectionUri)
            uris = [collectionUri];
        else
            uris = this.principalCollectionSet;

        lookupResults = [];
        var self = this;
        Async.list(uris)
            .each(function(uri, next) {
                self.handler.getNodeForPath(uri, function(err, principalCollection) {
                    if (err)
                        return next(err);

                    if (!principalCollection.hasFeature(jsDAVACL_iPrincipalCollection)) {
                        // Not a principal collection, we're simply going to ignore
                        // this.
                        return next();
                    }

                    principalCollection.searchPrincipals(searchProperties, function(err, results) {
                        if (err)
                            return next(err);

                        results.forEach(function(result) {
                            lookupResults.push(Util.rtrim(uri, "/") + "/" + result);
                        });
                        next();
                    });
                });
            })
            .end(function(err) {
                if (err)
                    return callback(err);

                var matches = [];
                Async.list(lookupResults)
                    .each(function(lookupResult, next) {
                        self.handler.getPropertiesForPath(lookupResult, requestedProperties, 0, function(err, props) {
                            if (err)
                                return next(err);

                            matches.push(props);
                            next();
                        });
                    })
                    .end(function(err) {
                        callback(err, matches)
                    });
            });
    },

    /**
     * Sets up the plugin
     *
     * This method is automatically called by the server class.
     *
     * @param jsDAV_Handler handler
     * @return void
     */
    initialize: function(handler) {
        this.handler = handler;

        handler.addEventListener("beforeGetProperties", this.beforeGetProperties.bind(this));
        handler.addEventListener("beforeMethod", this.beforeMethod.bind(this));
        handler.addEventListener("beforeBind", this.beforeBind.bind(this));
        handler.addEventListener("beforeUnbind", this.beforeUnbind.bind(this));
        handler.addEventListener("updateProperties",this.updateProperties.bind(this));
        handler.addEventListener("beforeUnlock", this.beforeUnlock.bind(this));
        handler.addEventListener("report",this.report.bind(this));
        handler.addEventListener("unknownMethod", this.unknownMethod.bind(this));

        handler.protectedProperties.push(
            "{DAV:}alternate-URI-set",
            "{DAV:}principal-URL",
            "{DAV:}group-membership",
            "{DAV:}principal-collection-set",
            "{DAV:}current-user-principal",
            "{DAV:}supported-privilege-set",
            "{DAV:}current-user-privilege-set",
            "{DAV:}acl",
            "{DAV:}acl-restrictions",
            "{DAV:}inherited-acl-set",
            "{DAV:}owner",
            "{DAV:}group"
        );

        // Automatically mapping nodes implementing IPrincipal to the
        // {DAV:}principal resourcetype.
        handler.resourceTypeMapping["jsDAVACL_iPrincipal"] = "{DAV:}principal";

        // Mapping the group-member-set property to the HrefList property
        // class.
        handler.propertyMap["{DAV:}group-member-set"] = "jsDAV_Property_HrefList";
    },

    /**
     * Triggered before any method is handled
     *
     * @param string method
     * @param string uri
     * @return void
     */
    beforeMethod: function(e, method, uri) {
        var self = this;
        this.handler.getNodeForPath(uri, function(err, node) {
            // do not yield errors:
            // If the node doesn't exists, none of these checks apply
            if (err)
                return e.next();

            switch(method) {
                case "GET" :
                case "HEAD" :
                case "OPTIONS" :
                    // For these 3 we only need to know if the node is readable.
                    self.checkPrivileges(uri, "{DAV:}read", null, e.next);
                    break;
                case "PUT" :
                case "LOCK" :
                case "UNLOCK" :
                    // This method requires the write-content priv if the node
                    // already exists, and bind on the parent if the node is being
                    // created.
                    // The bind privilege is handled in the beforeBind event.
                    self.checkPrivileges(uri, "{DAV:}write-content", null, e.next);
                    break;
                case "PROPPATCH" :
                    self.checkPrivileges(uri, "{DAV:}write-properties", null, e.next);
                    break;
                case "ACL" :
                    self.checkPrivileges(uri, "{DAV:}write-acl", null, e.next);
                    break;
                case "COPY" :
                case "MOVE" :
                    // Copy requires read privileges on the entire source tree.
                    // If the target exists write-content normally needs to be
                    // checked, however, we're deleting the node beforehand and
                    // creating a new one after, so this is handled by the
                    // beforeUnbind event.
                    //
                    // The creation of the new node is handled by the beforeBind
                    // event.
                    //
                    // If MOVE is used beforeUnbind will also be used to check if
                    // the sourcenode can be deleted.
                    self.checkPrivileges(uri, "{DAV:}read", self.R_RECURSIVE, e.next);
                    break;
                default:
                    e.next();
                    break;
            }
        });
    },

    /**
     * Triggered before a new node is created.
     *
     * This allows us to check permissions for any operation that creates a
     * new node, such as PUT, MKCOL, MKCALENDAR, LOCK, COPY and MOVE.
     *
     * @param string uri
     * @return void
     */
    beforeBind: function(e, uri) {
        var parentUri = Util.splitPath(uri)[0];
        this.checkPrivileges(parentUri, "{DAV:}bind", null, e.next);
    },

    /**
     * Triggered before a node is deleted
     *
     * This allows us to check permissions for any operation that will delete
     * an existing node.
     *
     * @param string uri
     * @return void
     */
    beforeUnbind: function(e, uri) {
        var parentUri = Util.splitPath(uri)[0];
        this.checkPrivileges(parentUri, "{DAV:}unbind", this.R_RECURSIVEPARENTS, e.next);
    },

    /**
     * Triggered before a node is unlocked.
     *
     * @param string uri
     * @param DAV\Locks\LockInfo lock
     * @TODO: not yet implemented
     * @return void
     */
    beforeUnlock: function(e, uri, lock) {
        e.next();
    },

    /**
     * Triggered before properties are looked up in specific nodes.
     *
     * @param string uri
     * @param DAV\INode node
     * @param array requestedProperties
     * @param array returnedProperties
     * @TODO really should be broken into multiple methods, or even a class.
     * @return bool
     */
    beforeGetProperties: function(e, uri, node, requestedProperties, returnedProperties) {
        // Checking the read permission
        var self = this;
        this.checkPrivileges(uri,"{DAV:}read", this.R_PARENT, function(err, hasPriv) {
            if (!hasPriv) {
                // User is not allowed to read properties
                if (self.hideNodesFromListings)
                    return e.stop();

                // Marking all requested properties as '403'.
                Object.keys(requestedProperties).forEach(function(key) {
                    delete requestedProperties[key];
                    returnedProperties["403"][requestedProperties[key]] = null;
                });
                return e.next();
            }

            /* Adding principal properties */
            if (node.hasFeature(jsDAVACL_iPrincipal)) {
                if (false !== (index = array_search("{DAV:}alternate-URI-set", requestedProperties))) {

                    unset(requestedProperties[index]);
                    returnedProperties[200]["{DAV:}alternate-URI-set"] = new DAV\Property\HrefList(node.getAlternateUriSet());

                }
                if (false !== (index = array_search("{DAV:}principal-URL", requestedProperties))) {

                    unset(requestedProperties[index]);
                    returnedProperties[200]["{DAV:}principal-URL"] = new DAV\Property\Href(node.getPrincipalUrl() . "/");

                }
                if (false !== (index = array_search("{DAV:}group-member-set", requestedProperties))) {

                    unset(requestedProperties[index]);
                    returnedProperties[200]["{DAV:}group-member-set"] = new DAV\Property\HrefList(node.getGroupMemberSet());

                }
                if (false !== (index = array_search("{DAV:}group-membership", requestedProperties))) {

                    unset(requestedProperties[index]);
                    returnedProperties[200]["{DAV:}group-membership"] = new DAV\Property\HrefList(node.getGroupMembership());

                }

                if (false !== (index = array_search("{DAV:}displayname", requestedProperties))) {

                    returnedProperties[200]["{DAV:}displayname"] = node.getDisplayName();

                }

            }
            if (false !== (index = array_search("{DAV:}principal-collection-set", requestedProperties))) {

                unset(requestedProperties[index]);
                val = this.principalCollectionSet;
                // Ensuring all collections end with a slash
                foreach(val as k=>v) val[k] = v . "/";
                returnedProperties[200]["{DAV:}principal-collection-set"] = new DAV\Property\HrefList(val);

            }
            if (false !== (index = array_search("{DAV:}current-user-principal", requestedProperties))) {

                unset(requestedProperties[index]);
                if (url = this.getCurrentUserPrincipal()) {
                    returnedProperties[200]["{DAV:}current-user-principal"] = new Property\Principal(Property\Principal::HREF, url . "/");
                } else {
                    returnedProperties[200]["{DAV:}current-user-principal"] = new Property\Principal(Property\Principal::UNAUTHENTICATED);
                }

            }
            if (false !== (index = array_search("{DAV:}supported-privilege-set", requestedProperties))) {

                unset(requestedProperties[index]);
                returnedProperties[200]["{DAV:}supported-privilege-set"] = new Property\SupportedPrivilegeSet(this.getSupportedPrivilegeSet(node));

            }
            if (false !== (index = array_search("{DAV:}current-user-privilege-set", requestedProperties))) {

                if (!this.checkPrivileges(uri, "{DAV:}read-current-user-privilege-set", self::R_PARENT, false)) {
                    returnedProperties[403]["{DAV:}current-user-privilege-set"] = null;
                    unset(requestedProperties[index]);
                } else {
                    val = this.getCurrentUserPrivilegeSet(node);
                    if (!is_null(val)) {
                        unset(requestedProperties[index]);
                        returnedProperties[200]["{DAV:}current-user-privilege-set"] = new Property\CurrentUserPrivilegeSet(val);
                    }
                }

            }

            /* The ACL property contains all the permissions */
            if (false !== (index = array_search("{DAV:}acl", requestedProperties))) {

                if (!this.checkPrivileges(uri, "{DAV:}read-acl", self::R_PARENT, false)) {

                    unset(requestedProperties[index]);
                    returnedProperties[403]["{DAV:}acl"] = null;

                } else {

                    acl = this.getACL(node);
                    if (!is_null(acl)) {
                        unset(requestedProperties[index]);
                        returnedProperties[200]["{DAV:}acl"] = new Property\Acl(this.getACL(node));
                    }

                }

            }

            /* The acl-restrictions property contains information on how privileges
             * must behave.
             */
            if (false !== (index = array_search("{DAV:}acl-restrictions", requestedProperties))) {
                unset(requestedProperties[index]);
                returnedProperties[200]["{DAV:}acl-restrictions"] = new Property\AclRestrictions();
            }

            /* Adding ACL properties */
            if (node instanceof IACL) {

                if (false !== (index = array_search("{DAV:}owner", requestedProperties))) {

                    unset(requestedProperties[index]);
                    returnedProperties[200]["{DAV:}owner"] = new DAV\Property\Href(node.getOwner() . "/");

                }

            }

        });


    }

    /**
     * This method intercepts PROPPATCH methods and make sure the
     * group-member-set is updated correctly.
     *
     * @param array propertyDelta
     * @param array result
     * @param DAV\INode node
     * @return bool
     */
    public function updateProperties(&propertyDelta, &result, DAV\INode node) {

        if (!array_key_exists("{DAV:}group-member-set", propertyDelta))
            return;

        if (is_null(propertyDelta["{DAV:}group-member-set"])) {
            memberSet = array();
        } elseif (propertyDelta["{DAV:}group-member-set"] instanceof DAV\Property\HrefList) {
            memberSet = array_map(
                array(this.server,"calculateUri"),
                propertyDelta["{DAV:}group-member-set"].getHrefs()
            );
        } else {
            throw new DAV\Exception("The group-member-set property MUST be an instance of Sabre\DAV\Property\HrefList or null");
        }

        if (!(node instanceof IPrincipal)) {
            result[403]["{DAV:}group-member-set"] = null;
            unset(propertyDelta["{DAV:}group-member-set"]);

            // Returning false will stop the updateProperties process
            return false;
        }

        node.setGroupMemberSet(memberSet);
        // We must also clear our cache, just in case

        this.principalMembershipCache = array();

        result[200]["{DAV:}group-member-set"] = null;
        unset(propertyDelta["{DAV:}group-member-set"]);

    }

    /**
     * This method handles HTTP REPORT requests
     *
     * @param string reportName
     * @param \DOMNode dom
     * @return bool
     */
    public function report(reportName, dom) {

        switch(reportName) {

            case "{DAV:}principal-property-search" :
                this.principalPropertySearchReport(dom);
                return false;
            case "{DAV:}principal-search-property-set" :
                this.principalSearchPropertySetReport(dom);
                return false;
            case "{DAV:}expand-property" :
                this.expandPropertyReport(dom);
                return false;

        }

    }

    /**
     * This event is triggered for any HTTP method that is not known by the
     * webserver.
     *
     * @param string method
     * @param string uri
     * @return bool
     */
    public function unknownMethod(method, uri) {

        if (method!=="ACL") return;

        this.httpACL(uri);
        return false;

    }

    /**
     * This method is responsible for handling the 'ACL' event.
     *
     * @param string uri
     * @return void
     */
    public function httpACL(uri) {

        body = this.server.httpRequest.getBody(true);
        dom = DAV\XMLUtil::loadDOMDocument(body);

        newAcl =
            Property\Acl::unserialize(dom.firstChild)
            .getPrivileges();

        // Normalizing urls
        foreach(newAcl as k=>newAce) {
            newAcl[k]["principal"] = this.server.calculateUri(newAce["principal"]);
        }

        node = this.server.tree.getNodeForPath(uri);

        if (!(node instanceof IACL)) {
            throw new DAV\Exception\MethodNotAllowed("This node does not support the ACL method");
        }

        oldAcl = this.getACL(node);

        supportedPrivileges = this.getFlatPrivilegeSet(node);

        /* Checking if protected principals from the existing principal set are
           not overwritten. */
        foreach(oldAcl as oldAce) {

            if (!isset(oldAce["protected"]) || !oldAce["protected"]) continue;

            found = false;
            foreach(newAcl as newAce) {
                if (
                    newAce["privilege"] === oldAce["privilege"] &&
                    newAce["principal"] === oldAce["principal"] &&
                    newAce["protected"]
                )
                found = true;
            }

            if (!found)
                throw new Exception\AceConflict("This resource contained a protected {DAV:}ace, but this privilege did not occur in the ACL request");

        }

        foreach(newAcl as newAce) {

            // Do we recognize the privilege
            if (!isset(supportedPrivileges[newAce["privilege"]])) {
                throw new Exception\NotSupportedPrivilege("The privilege you specified (" . newAce["privilege"] . ") is not recognized by this server");
            }

            if (supportedPrivileges[newAce["privilege"]]["abstract"]) {
                throw new Exception\NoAbstract("The privilege you specified (" . newAce["privilege"] . ") is an abstract privilege");
            }

            // Looking up the principal
            try {
                principal = this.server.tree.getNodeForPath(newAce["principal"]);
            } catch (DAV\Exception\NotFound e) {
                throw new Exception\NotRecognizedPrincipal("The specified principal (" . newAce["principal"] . ") does not exist");
            }
            if (!(principal instanceof IPrincipal)) {
                throw new Exception\NotRecognizedPrincipal("The specified uri (" . newAce["principal"] . ") is not a principal");
            }

        }
        node.setACL(newAcl);

    }

    /* }}} */

    /* Reports {{{ */

    /**
     * The expand-property report is defined in RFC3253 section 3-8.
     *
     * This report is very similar to a standard PROPFIND. The difference is
     * that it has the additional ability to look at properties containing a
     * {DAV:}href element, follow that property and grab additional elements
     * there.
     *
     * Other rfc's, such as ACL rely on this report, so it made sense to put
     * it in this plugin.
     *
     * @param \DOMElement dom
     * @return void
     */
    protected function expandPropertyReport(dom) {

        requestedProperties = this.parseExpandPropertyReportRequest(dom.firstChild.firstChild);
        depth = this.server.getHTTPDepth(0);
        requestUri = this.server.getRequestUri();

        result = this.expandProperties(requestUri,requestedProperties,depth);

        dom = new \DOMDocument("1.0","utf-8");
        dom.formatOutput = true;
        multiStatus = dom.createElement("d:multistatus");
        dom.appendChild(multiStatus);

        // Adding in default namespaces
        foreach(this.server.xmlNamespaces as namespace=>prefix) {

            multiStatus.setAttribute("xmlns:" . prefix,namespace);

        }

        foreach(result as response) {
            response.serialize(this.server, multiStatus);
        }

        xml = dom.saveXML();
        this.server.httpResponse.setHeader("Content-Type","application/xml; charset=utf-8");
        this.server.httpResponse.sendStatus(207);
        this.server.httpResponse.sendBody(xml);

    }

    /**
     * This method is used by expandPropertyReport to parse
     * out the entire HTTP request.
     *
     * @param \DOMElement node
     * @return array
     */
    protected function parseExpandPropertyReportRequest(node) {

        requestedProperties = array();
        do {

            if (DAV\XMLUtil::toClarkNotation(node)!=="{DAV:}property") continue;

            if (node.firstChild) {

                children = this.parseExpandPropertyReportRequest(node.firstChild);

            } else {

                children = array();

            }

            namespace = node.getAttribute("namespace");
            if (!namespace) namespace = "DAV:";

            propName = "{".namespace."}" . node.getAttribute("name");
            requestedProperties[propName] = children;

        } while (node = node.nextSibling);

        return requestedProperties;

    }

    /**
     * This method expands all the properties and returns
     * a list with property values
     *
     * @param array path
     * @param array requestedProperties the list of required properties
     * @param int depth
     * @return array
     */
    protected function expandProperties(path, array requestedProperties, depth) {

        foundProperties = this.server.getPropertiesForPath(path, array_keys(requestedProperties), depth);

        result = array();

        foreach(foundProperties as node) {

            foreach(requestedProperties as propertyName=>childRequestedProperties) {

                // We're only traversing if sub-properties were requested
                if(count(childRequestedProperties)===0) continue;

                // We only have to do the expansion if the property was found
                // and it contains an href element.
                if (!array_key_exists(propertyName,node[200])) continue;

                if (node[200][propertyName] instanceof DAV\Property\IHref) {
                    hrefs = array(node[200][propertyName].getHref());
                } elseif (node[200][propertyName] instanceof DAV\Property\HrefList) {
                    hrefs = node[200][propertyName].getHrefs();
                }

                childProps = array();
                foreach(hrefs as href) {
                    childProps = array_merge(childProps, this.expandProperties(href, childRequestedProperties, 0));
                }
                node[200][propertyName] = new DAV\Property\ResponseList(childProps);

            }
            result[] = new DAV\Property\Response(path, node);

        }

        return result;

    }

    /**
     * principalSearchPropertySetReport
     *
     * This method responsible for handing the
     * {DAV:}principal-search-property-set report. This report returns a list
     * of properties the client may search on, using the
     * {DAV:}principal-property-search report.
     *
     * @param \DOMDocument dom
     * @return void
     */
    protected function principalSearchPropertySetReport(\DOMDocument dom) {

        httpDepth = this.server.getHTTPDepth(0);
        if (httpDepth!==0) {
            throw new DAV\Exception\BadRequest("This report is only defined when Depth: 0");
        }

        if (dom.firstChild.hasChildNodes())
            throw new DAV\Exception\BadRequest("The principal-search-property-set report element is not allowed to have child elements");

        dom = new \DOMDocument("1.0","utf-8");
        dom.formatOutput = true;
        root = dom.createElement("d:principal-search-property-set");
        dom.appendChild(root);
        // Adding in default namespaces
        foreach(this.server.xmlNamespaces as namespace=>prefix) {

            root.setAttribute("xmlns:" . prefix,namespace);

        }

        nsList = this.server.xmlNamespaces;

        foreach(this.principalSearchPropertySet as propertyName=>description) {

            psp = dom.createElement("d:principal-search-property");
            root.appendChild(psp);

            prop = dom.createElement("d:prop");
            psp.appendChild(prop);

            propName = null;
            preg_match("/^{([^}]*)}(.*)/",propertyName,propName);

            currentProperty = dom.createElement(nsList[propName[1]] . ":" . propName[2]);
            prop.appendChild(currentProperty);

            descriptionElem = dom.createElement("d:description");
            descriptionElem.setAttribute("xml:lang","en");
            descriptionElem.appendChild(dom.createTextNode(description));
            psp.appendChild(descriptionElem);


        }

        this.server.httpResponse.setHeader("Content-Type","application/xml; charset=utf-8");
        this.server.httpResponse.sendStatus(200);
        this.server.httpResponse.sendBody(dom.saveXML());

    }

    /**
     * principalPropertySearchReport
     *
     * This method is responsible for handing the
     * {DAV:}principal-property-search report. This report can be used for
     * clients to search for groups of principals, based on the value of one
     * or more properties.
     *
     * @param \DOMDocument dom
     * @return void
     */
    protected function principalPropertySearchReport(\DOMDocument dom) {

        list(searchProperties, requestedProperties, applyToPrincipalCollectionSet) = this.parsePrincipalPropertySearchReportRequest(dom);

        uri = null;
        if (!applyToPrincipalCollectionSet) {
            uri = this.server.getRequestUri();
        }
        result = this.principalSearch(searchProperties, requestedProperties, uri);

        prefer = this.server.getHTTPPRefer();

        this.server.httpResponse.sendStatus(207);
        this.server.httpResponse.setHeader("Content-Type","application/xml; charset=utf-8");
        this.server.httpResponse.setHeader("Vary","Brief,Prefer");
        this.server.httpResponse.sendBody(this.server.generateMultiStatus(result, prefer["return-minimal"]));

    }

    /**
     * parsePrincipalPropertySearchReportRequest
     *
     * This method parses the request body from a
     * {DAV:}principal-property-search report.
     *
     * This method returns an array with two elements:
     *  1. an array with properties to search on, and their values
     *  2. a list of propertyvalues that should be returned for the request.
     *
     * @param \DOMDocument dom
     * @return array
     */
    protected function parsePrincipalPropertySearchReportRequest(dom) {

        httpDepth = this.server.getHTTPDepth(0);
        if (httpDepth!==0) {
            throw new DAV\Exception\BadRequest("This report is only defined when Depth: 0");
        }

        searchProperties = array();

        applyToPrincipalCollectionSet = false;

        // Parsing the search request
        foreach(dom.firstChild.childNodes as searchNode) {

            if (DAV\XMLUtil::toClarkNotation(searchNode) == "{DAV:}apply-to-principal-collection-set") {
                applyToPrincipalCollectionSet = true;
            }

            if (DAV\XMLUtil::toClarkNotation(searchNode)!=="{DAV:}property-search")
                continue;

            propertyName = null;
            propertyValue = null;

            foreach(searchNode.childNodes as childNode) {

                switch(DAV\XMLUtil::toClarkNotation(childNode)) {

                    case "{DAV:}prop" :
                        property = DAV\XMLUtil::parseProperties(searchNode);
                        reset(property);
                        propertyName = key(property);
                        break;

                    case "{DAV:}match" :
                        propertyValue = childNode.textContent;
                        break;

                }


            }

            if (is_null(propertyName) || is_null(propertyValue))
                throw new DAV\Exception\BadRequest("Invalid search request. propertyname: " . propertyName . ". propertvvalue: " . propertyValue);

            searchProperties[propertyName] = propertyValue;

        }

        return array(searchProperties, array_keys(DAV\XMLUtil::parseProperties(dom.firstChild)), applyToPrincipalCollectionSet);

    }


    /* }}} */

});