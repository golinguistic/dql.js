// @flow
import Nodes from './Nodes';
import QueryProcessor from '../processors/QueryProcessor';

function resolveVariable(variable, variables) {
    const v = variables[variable];

    if (typeof v === 'undefined')
        throw new Error(`Could not find variable: ${variable}`);

    return v;
}

const getFieldValue = (table, node, aliases) =>
    table !== null
        ? typeof aliases[node.value] !== 'undefined'
          ? node.alias
          : `${table}.${node.value}`
        : node.value;

class FilterString {
    /**
     * Handles case where no other conditions are matched and text is treated as a field
     *
     * @param table     Table name
     * @param node      Current node
     * @param aliases   Pre-defined field aliases
     * @private
     */
    _handleText = (table, node, aliases) => ({
        // Assume anything else is a field, and prepend
        // the table name if one is available
        text: '?',
        variables: [getFieldValue(table, node, aliases)]
    });

    /**
     * Handles case where text appears on the left side of the operator
     *
     * @param table     Table name
     * @param node      Current node
     * @param aliases   Pre-defined field aliases
     * @private
     */
    _handleLeftSide = (table, node, aliases) => ({
        text: getFieldValue(table, node, aliases),
        variables: []
    });

    /**
     * Handles case where node is a call to a neighboring query (document)
     *
     * @param root      Document root
     * @param node      Current node
     * @param flavor    Flavor to use for SQL (postgres, mysql, mssql)
     * @returns {{text: string, variables: [null]}}
     * @private
     */
    _handleQueryCall(root, node, variables, flavor) {
        // If the node is a call to a neighboring query
        // Locate the query
        const target_query = root.filter(
            x => x.type === 'QUERY' && x.name === node.name
        )[0];

        if (typeof target_query === 'undefined')
            throw new Error(`Could not find query '${node.name}`);

        // Extract the required variables in the query declaration
        const { variables: tq_variables } = target_query;

        // Initialize a map of variables
        const vmap = {};

        // For each of the required variables
        tq_variables.forEach((v, index) => {
            const param = node.params[index];

            // If the param passed at the end of that variable is itself
            // a variable, resolve it before passing it in
            if (param.type === Nodes.VARIABLE) {
                vmap[v] = resolveVariable(param.value, variables);
            } else
                // Otherwise just pass in the param
                vmap[v] = param.value;
        });

        // Return the object and process the call
        return {
            text: '?',
            variables: [
                QueryProcessor(flavor).process(root, target_query, {
                    variables: vmap
                })
            ]
        };
    }

    /**
     * Handles case where current node is a built-in SQL function
     *
     * @param node  Current node
     * @private
     */
    _handleBuiltIn = node => ({
        // If the node is a built-in SQL function such as INTERVAL
        // Return built-in SQL operations as is
        // They're not special
        text: node.value,
        variables: []
    });

    /**
     * Handles case where current node is a variable
     *
     * @param node  Current node
     * @private
     */
    _handleVariable = (node, variables) => ({
        // If the node is a $variable
        // Resolve any variable node and return the object
        // The text just becomes '?', which tells Squel where
        // to interpolate the variable
        text: '?',
        variables: [resolveVariable(node.value, variables)]
    });

    /**
     * Handles case where current node is another operator
     *
     * @param root          Document root
     * @param table         Table name
     * @param node          Current node
     * @param variables     Global variable map
     * @param aliases       Pre-defined field aliases
     * @param flavor        Flavor to use for SQL
     * @returns {{text: string, variables: [null,null]}}
     * @private
     */
    _handleOperation(root, table, node, variables, aliases, flavor) {
        const a = node.a;
        const op = node.op;
        const b = node.b;

        // Recurse on both sides of the operand
        const a_bos = this._buildString(
            root,
            table,
            a,
            variables,
            true,
            aliases,
            flavor
        );

        const b_bos = this._buildString(
            root,
            null,
            b,
            variables,
            false,
            aliases,
            flavor
        );

        // We return text and variables separately to allow Squel
        // to sanitize the input
        return {
            text: `${a_bos.text} ${op} ${b_bos.text}`,
            variables: [...a_bos.variables, ...b_bos.variables]
        };
    }

    /**
     * Builds a string from the operator tree found in selector blocks (inside parens)
     *
     * @param root          Document root
     * @param table         Table name
     * @param node          Current node
     * @param variables     Global variable map
     * @param left_side     Boolean denoting whether the node is on the left site of an operator
     * @param aliases       Pre-defined field aliases
     * @param flavor        Flavor to use for SQL
     * @returns {*}
     */
    _buildString(root, table, node, variables, left_side, aliases, flavor) {
        switch (node.type) {
            case Nodes.OPERATION:
                return this._handleOperation(
                    root,
                    table,
                    node,
                    variables,
                    aliases,
                    flavor
                );
                break;
            case Nodes.VARIABLE:
                return this._handleVariable(node, variables);
                break;
            case Nodes.BUILT_IN:
                return this._handleBuiltIn(node);
                break;
            case Nodes.QUERY_CALL:
                return this._handleQueryCall(root, node, variables, flavor);
                break;
            default:
                return left_side
                    ? this._handleLeftSide(table, node, aliases)
                    : this._handleText(table, node, aliases);
        }
    }

    constructor(root, table, node, variables, aliases, flavor) {
        this._string = this._buildString(
            root,
            table,
            node,
            variables,
            false,
            aliases || {},
            flavor
        );
    }

    toString = () => this._string;
}

export default FilterString;